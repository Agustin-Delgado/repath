/** The local Arduino Uno compiler, loaded only by Vite. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
	access, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFirmware } from '../schematic/firmware.ts';

// A sketch is text and an Uno's flash is 32 KB, so 64 KB is generous for any real sketch
// while keeping a stray or hostile upload small.
const BODY_LIMIT = 64 * 1024;
// Room for the first compiler errors; a runaway message would only flood the inspector.
const DIAGNOSTIC_LIMIT = 8 * 1024;
// A sketch compiles in well under a second on a warm core cache, so anything near 30 s is
// stuck, and a stuck compile would hold the single compile lock.
const TIMEOUT = 30_000;
// The ATmega328P's flash.
const FLASH_BYTES = 32 * 1024;
const TIMEOUT_MESSAGE = 'Arduino compilation timed out (30 s).';
let busy = false;

/** Windows tools carry an extension; `execFile` and `access` do not add it. */
const EXE = process.platform === 'win32' ? '.exe' : '';

async function newest(root: string): Promise<string | undefined> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	directories.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	return directories[0] === undefined ? undefined : join(root, directories[0]);
}

/** Where the Arduino IDE and arduino-cli keep their board packages on each system. */
function defaultDataDirectories(): string[] {
	if (process.platform === 'win32') {
		return [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Arduino15')];
	}
	if (process.platform === 'darwin') return [join(homedir(), 'Library', 'Arduino15')];
	return [join(homedir(), '.arduino15')];
}

/**
 * Ask an arduino-cli on PATH where it keeps its data, so a changed `directories.data` is
 * honoured. Only that one question is asked, with fixed arguments and no shell; the
 * program is compiled with the avr-gcc found there, not through arduino-cli.
 */
function arduinoCliDataDirectory(): Promise<string | undefined> {
	return new Promise((accept) => {
		execFile('arduino-cli' + EXE, ['config', 'get', 'directories.data'], {
			timeout: 5_000, shell: false, encoding: 'utf8'
		}, (error, stdout) => accept(error ? undefined : stdout.trim().split(/\r?\n/)[0] || undefined));
	});
}

async function locate(dataDirectory: string): Promise<{ bin: string; core: string } | string> {
	const root = join(dataDirectory, 'packages', 'arduino');
	const compilerRoot = await newest(join(root, 'tools', 'avr-gcc'));
	const core = await newest(join(root, 'hardware', 'avr'));
	if (!compilerRoot || !core) {
		return !core && !compilerRoot ? 'the AVR core is not installed'
			: !core ? 'the AVR board files are missing' : 'avr-gcc is missing';
	}
	const bin = join(compilerRoot, 'bin');
	try {
		for (const tool of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy']) {
			await access(join(bin, tool + EXE), constants.X_OK);
		}
		await access(join(core, 'cores', 'arduino', 'Arduino.h'));
		await access(join(core, 'variants', 'standard', 'pins_arduino.h'));
	} catch {
		return 'the AVR core is incomplete; reinstall it';
	}
	return { bin, core };
}

const INSTALL = 'Install the Arduino IDE, or run: arduino-cli core install arduino:avr';

/**
 * Find avr-gcc and the AVR core. In order: REPATH_ARDUINO_AVR_BIN with REPATH_ARDUINO_CORE
 * when both are set; ARDUINO_DATA_DIR alone when set, so a typo is reported rather than
 * quietly replaced; otherwise the IDE's own folder for this system and then wherever an
 * arduino-cli on PATH keeps its data. The error says what was looked at and why it failed.
 */
async function discoverToolchain(): Promise<{ bin: string; core: string }> {
	if (process.env.REPATH_ARDUINO_AVR_BIN && process.env.REPATH_ARDUINO_CORE) {
		return { bin: resolve(process.env.REPATH_ARDUINO_AVR_BIN), core: resolve(process.env.REPATH_ARDUINO_CORE) };
	}
	const explicit = process.env.ARDUINO_DATA_DIR;
	const problems: string[] = [];
	const tried = new Set<string>();
	const search = async (dir: string) => {
		if (tried.has(dir)) return undefined;
		tried.add(dir);
		if (!(await stat(dir).then((info) => info.isDirectory(), () => false))) {
			problems.push(`${dir}: no such folder`);
			return undefined;
		}
		const found = await locate(dir);
		if (typeof found !== 'string') return found;
		problems.push(`${dir}: ${found}`);
		return undefined;
	};
	for (const dir of explicit ? [resolve(explicit)] : defaultDataDirectories()) {
		const found = await search(dir);
		if (found) return found;
	}
	// Only when the IDE's folder has nothing: asking arduino-cli starts a program.
	const configured = explicit ? undefined : await arduinoCliDataDirectory();
	const found = configured && await search(configured);
	if (found) return found;
	throw new Error(`Arduino AVR core not found. ${INSTALL}. Looked in ${problems.join('; ')}. Set ARDUINO_DATA_DIR to use another folder.`);
}

// Match literals before comments so a comment marker inside a string stays a literal.
const commentsAndLiterals =
	/R"([^\s()\\]{0,16})\([\s\S]*?\)\1"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Every header the sketch includes, or throws on an include it may not make. */
export function sketchIncludes(sketch: string): string[] {
	// Undo the preprocessor's own rewrites (line splices, trigraphs, digraphs) first, or an
	// #include spelled that way would slip past the check below.
	const normalized = sketch.replace(/\r\n?/g, '\n')
		.replace(/\?\?=/g, '#').replace(/\?\?\//g, '\\').replace(/%:/g, '#')
		.replace(/\\[^\S\n]*\n/g, '')
		.replace(commentsAndLiterals, (token) => token.startsWith('/') ? ' ' : token);
	const names: string[] = [];
	for (const match of normalized.matchAll(/^[^\S\n]*#[^\S\n]*(?:include(?:_next)?|import|embed)\b([^\n]*)/gm)) {
		const operand = match[1].trim();
		const name = operand.match(/^(?:<([\w.+/-]+)>|"([\w.+/-]+)")$/)?.slice(1).find(Boolean);
		if (!name || name.startsWith('/') || name.split('/').includes('..')) {
			throw new Error('Only relative literal #include paths without .. are allowed.');
		}
		names.push(name);
	}
	return names;
}

export function prepareArduinoSketch(sketch: string): string {
	sketchIncludes(sketch);

	const masked = sketch.replace(commentsAndLiterals, (token) => token.replace(/[^\n]/g, ' '));
	const prototypes: string[] = [];
	let depth = 0;
	let boundary = 0;
	for (let i = 0; i < masked.length; i++) {
		const char = masked[i];
		if (char === '{') {
			if (depth === 0) {
				const signature = masked.slice(boundary, i).replace(/^\s*#.*$/gm, '').trim();
				// The Arduino IDE adds prototypes, so a sketch may call a function defined below it.
				if (/^(?:[\w:*&]+\s+)+[A-Za-z_]\w*\s*\([^{};=]*\)\s*$/.test(signature) &&
					!/^(?:class|struct|enum|namespace|template)\b/.test(signature)) {
					prototypes.push(signature + ';');
				}
			}
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) boundary = i + 1;
		} else if (char === ';' && depth === 0) {
			boundary = i + 1;
		}
	}
	return '#include <Arduino.h>\n' + prototypes.join('\n') + '\n#line 1 "sketch.ino"\n' + sketch;
}

type Run = (tool: string, args: string[]) => Promise<void>;

/**
 * Compile `sources` into one archive and keep it, so the core and each library are built
 * once rather than on every Compile. The key covers what the objects depend on, so a new
 * toolchain or board package gets a fresh build instead of a stale one.
 */
async function archive(
	name: string, sources: string[], bin: string, core: string,
	flags: string[], cppFlags: string[], run: Run
) {
	const key = createHash('sha256').update(JSON.stringify([
		name, bin, core, (await stat(join(bin, 'avr-gcc' + EXE))).mtimeMs,
		...(await Promise.all(sources.map(async (dir) => (await stat(dir)).mtimeMs)))
	])).digest('hex');
	const root = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'repath', 'arduino-core');
	await mkdir(root, { recursive: true, mode: 0o700 });
	const cache = join(root, key);
	const built = join(cache, 'archive.a');
	const info = await lstat(built).catch(() => undefined);
	// Only trust an archive this user wrote: it is linked into the program.
	if (info?.isFile() && (typeof process.getuid !== 'function' || info.uid === process.getuid())) {
		return built;
	}

	// Each server builds in its own directory and publishes the archive atomically.
	const staging = await mkdtemp(join(root, 'build-'));
	try {
		const objects: string[] = [];
		for (const [index, dir] of sources.entries()) {
			for (const file of (await readdir(dir)).sort()) {
				if (!/\.(?:c|cpp|S)$/.test(file)) continue;
				const object = join(staging, `${index}-${file}.o`);
				objects.push(object);
				const cpp = file.endsWith('.cpp');
				const languageFlags = cpp ? cppFlags : file.endsWith('.c') ? ['-std=gnu11'] : [];
				await run(cpp ? 'avr-g++' : 'avr-gcc', [...flags, '-c', ...languageFlags, join(dir, file), '-o', object]);
			}
		}
		await run('avr-gcc-ar', ['rcs', join(staging, 'archive.a'), ...objects]);
		await mkdir(cache, { recursive: true, mode: 0o700 });
		await rename(join(staging, 'archive.a'), built);
		return built;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

interface Library {
	name: string;
	/** Where its headers are, and so where its sources are: `src`, and `src/utility` when there is one. */
	directories: string[];
}

/**
 * The libraries that ship inside the Arduino AVR core, by the headers they offer. Nothing
 * else is offered: not the user's own sketchbook libraries and not an arbitrary path, so
 * what a sketch can pull in is fixed by the installed board package.
 */
async function coreLibraries(core: string): Promise<Map<string, Library>> {
	const headers = new Map<string, Library>();
	const root = join(core, 'libraries');
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory()) continue;
		const src = join(root, entry.name, 'src');
		const files = await readdir(src).catch(() => undefined);
		if (!files) continue;
		const utility = join(src, 'utility');
		const library: Library = {
			name: entry.name,
			directories: (await stat(utility).then((info) => info.isDirectory(), () => false)) ? [src, utility] : [src]
		};
		for (const file of files) if (file.endsWith('.h')) headers.set(file, library);
	}
	return headers;
}

function limitDiagnostics(value: string): string {
	return Buffer.from(value).subarray(0, DIAGNOSTIC_LIMIT).toString('utf8').replace(/\uFFFD$/, '');
}

async function compile(source: string, included: string[], directory: string, signal: AbortSignal) {
	const { bin, core } = await discoverToolchain();
	const available = await coreLibraries(core);
	const libraries = [...new Set(included.map((name) => available.get(name)).filter((l): l is Library => !!l))];
	let diagnostics = '';
	const run: Run = (tool, args) => new Promise<void>((accept, reject) => {
		execFile(join(bin, tool + EXE), args, {
			cwd: directory, signal, timeout: TIMEOUT, maxBuffer: DIAGNOSTIC_LIMIT, shell: false
		}, (error, stdout, stderr) => {
			diagnostics = limitDiagnostics(diagnostics + stdout + stderr);
			if (signal.aborted) reject(new Error(TIMEOUT_MESSAGE));
			else if (error) reject(new Error(diagnostics || error.message));
			else accept();
		});
	});

	const flags = [
		'-g', '-Os', '-w', '-mmcu=atmega328p', '-DF_CPU=16000000L', '-DARDUINO=10819',
		'-DARDUINO_AVR_UNO', '-DARDUINO_ARCH_AVR', '-ffunction-sections', '-fdata-sections',
		'-I' + join(core, 'cores', 'arduino'), '-I' + join(core, 'variants', 'standard')
	];
	const cppFlags = ['-ftemplate-depth=128', '-std=gnu++11', '-fpermissive', '-fno-exceptions', '-fno-threadsafe-statics'];
	const libraryFlags = libraries.flatMap((library) => library.directories.map((dir) => '-I' + dir));
	// One at a time: they share `run`'s diagnostics, and a cold cache is a one-off cost.
	const archives: string[] = [];
	for (const library of libraries) {
		archives.push(await archive(
			'library:' + library.name, library.directories, bin, core,
			[...flags, ...library.directories.map((dir) => '-I' + dir)], cppFlags, run));
	}
	// Libraries before the core: the linker resolves what they need from what follows.
	archives.push(await archive('core', [join(core, 'cores', 'arduino')], bin, core, flags, cppFlags, run));
	await writeFile(join(directory, 'sketch.cpp'), source);

	// Inspect the expanded inline assembly before the assembler can read any files.
	try {
		await run('avr-g++', [...flags, ...libraryFlags, '-S', ...cppFlags, 'sketch.cpp', '-o', 'sketch.s']);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const missing = message.match(/fatal error: ([\w.+/-]+): No such file or directory/)?.[1];
		// Say it plainly rather than leave the user with the compiler's bare line.
		if (missing && included.includes(missing)) {
			throw new Error(
				`Library not found: ${missing}. Only the libraries that come with the Arduino AVR core can be used here (${[...new Set([...available.values()].map((l) => l.name))].sort().join(', ')}).\n\n${message}`
			);
		}
		throw cause;
	}
	const assembly = await readFile(join(directory, 'sketch.s'), 'utf8');
	if (/(?:^|[\s:;$])\.(?:incbin|include|macro|irpc?|rept|altmacro|purgem)\b/im.test(assembly)) {
		throw new Error('Inline assembly that includes files or defines assembler macros is not allowed.');
	}
	await run('avr-gcc', ['-c', '-mmcu=atmega328p', '-x', 'assembler', 'sketch.s', '-o', 'sketch.o']);
	await run('avr-gcc', ['-Os', '-Wl,--gc-sections', '-mmcu=atmega328p', '-o', 'sketch.elf', 'sketch.o', ...archives, '-lm']);
	await run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', 'sketch.elf', 'sketch.hex']);
	const hex = await readFile(join(directory, 'sketch.hex'), 'utf8');
	const { bytes, problem } = readFirmware(hex, FLASH_BYTES);
	if (problem || !bytes) throw new Error(problem || 'The compiled program is empty.');
	return { ok: true, hex, bytes, diagnostics };
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
	return new Promise((accept, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		function cleanup() {
			req.off('data', data);
			req.off('end', end);
			req.off('error', fail);
			req.off('aborted', aborted);
			signal.removeEventListener('abort', expired);
		}
		function fail(cause: Error) {
			cleanup();
			reject(cause);
		}
		function data(chunk: Buffer) {
			length += chunk.length;
			if (length > BODY_LIMIT) fail(new Error('Request body exceeds 64 KB.'));
			else chunks.push(chunk);
		}
		function end() {
			cleanup();
			accept(Buffer.concat(chunks).toString('utf8'));
		}
		const expired = () => fail(new Error(TIMEOUT_MESSAGE));
		const aborted = () => fail(new Error('Request was interrupted.'));
		req.on('data', data);
		req.once('end', end);
		req.once('error', fail);
		req.once('aborted', aborted);
		signal.addEventListener('abort', expired, { once: true });
	});
}

export async function handleArduinoCompileRequest(req: IncomingMessage, res: ServerResponse) {
	function send(status: number, body: object) {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff'
		});
		res.end(JSON.stringify(body));
	}
	const refuse = (status: number, diagnostics: string) => send(status, { ok: false, diagnostics });
	const host = req.headers.host ?? '';
	if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) {
		return refuse(403, 'Only loopback hosts are allowed.');
	}
	const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
	if (req.headers.origin !== undefined && req.headers.origin !== `${protocol}://${host}`) {
		return refuse(403, 'Origin must match the local request host.');
	}
	if (req.method === 'GET') {
		// Say why not: the panel tells the user what to install or set.
		return send(200, await discoverToolchain().then(
			() => ({ available: true }),
			(cause) => ({ available: false, reason: cause instanceof Error ? cause.message : String(cause) })
		));
	}
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'GET, POST');
		return refuse(405, 'Use GET or POST.');
	}
	if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
		return refuse(415, 'Content-Type must be application/json.');
	}
	if (req.headers['x-repath-compile'] !== '1') return refuse(403, 'X-Repath-Compile: 1 is required.');
	if (Number(req.headers['content-length']) > BODY_LIMIT) return refuse(413, 'Request body exceeds 64 KB.');

	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), TIMEOUT);
	let directory: string | undefined;
	const diagnostics = (value: string) => limitDiagnostics(directory
		? value.replaceAll(join(directory, 'sketch.cpp'), 'sketch.ino').replaceAll(directory, 'sketch.ino')
		: value);
	try {
		const raw = await readBody(req, abort.signal);
		let body: { sketch?: unknown };
		try {
			body = JSON.parse(raw);
		} catch {
			return refuse(400, 'Invalid JSON body.');
		}
		if (typeof body?.sketch !== 'string' || !body.sketch.trim()) {
			return refuse(400, 'Provide a non-empty sketch string.');
		}
		// A stalled upload holds no compile lock.
		if (busy) return refuse(429, 'Arduino compiler is busy. Try again after the current compilation.');
		const source = prepareArduinoSketch(body.sketch);
			const included = sketchIncludes(body.sketch);
		busy = true;
		let result;
		try {
			directory = await mkdtemp(join(tmpdir(), 'repath-arduino-request-'));
			result = await compile(source, included, directory, abort.signal);
		} finally {
			try {
				if (directory) await rm(directory, { recursive: true, force: true });
			} finally {
				busy = false;
			}
		}
		return send(200, { ...result, diagnostics: diagnostics(result.diagnostics) });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return refuse(message === 'Request body exceeds 64 KB.' ? 413 : 400, diagnostics(message));
	} finally {
		clearTimeout(timeout);
	}
}
