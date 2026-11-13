//! A hand assembler for the tests: each function is one row of the opcode
//! table in the AVR instruction set manual, with its operand bits put where
//! that row says. No toolchain is needed to write a test program, and the
//! encodings are checked against bytes out of real builds in
//! `machine::tests::the_avr_gcc_startup_sets_the_stack_and_clears_sreg`.

/// `0000 01rd dddd rrrr` and its relatives: two registers, five bits each.
fn rr(base: u16, d: u16, r: u16) -> u16 {
    base | ((r & 0x10) << 5) | (d << 4) | (r & 0x0F)
}

/// `KKKK dddd KKKK` on R16..R31.
fn imm(base: u16, d: u16, k: u8) -> u16 {
    let k = u16::from(k);
    base | ((k & 0xF0) << 4) | ((d - 16) << 4) | (k & 0x0F)
}

fn one(low: u16, d: u16) -> u16 {
    0x9400 | (d << 4) | low
}

fn io_bit(base: u16, a: u16, b: u16) -> u16 {
    base | (a << 3) | b
}

pub fn nop() -> u16 {
    0x0000
}
pub fn add(d: u16, r: u16) -> u16 {
    rr(0x0C00, d, r)
}
pub fn adc(d: u16, r: u16) -> u16 {
    rr(0x1C00, d, r)
}
pub fn sub(d: u16, r: u16) -> u16 {
    rr(0x1800, d, r)
}
pub fn sbc(d: u16, r: u16) -> u16 {
    rr(0x0800, d, r)
}
pub fn cp(d: u16, r: u16) -> u16 {
    rr(0x1400, d, r)
}
pub fn cpc(d: u16, r: u16) -> u16 {
    rr(0x0400, d, r)
}
pub fn cpse(d: u16, r: u16) -> u16 {
    rr(0x1000, d, r)
}
pub fn and(d: u16, r: u16) -> u16 {
    rr(0x2000, d, r)
}
pub fn eor(d: u16, r: u16) -> u16 {
    rr(0x2400, d, r)
}
pub fn mul_(d: u16, r: u16) -> u16 {
    rr(0x9C00, d, r)
}
pub fn ldi(d: u16, k: u8) -> u16 {
    imm(0xE000, d, k)
}
pub fn sbci(d: u16, k: u8) -> u16 {
    imm(0x4000, d, k)
}
pub fn com(d: u16) -> u16 {
    one(0x0, d)
}
pub fn neg(d: u16) -> u16 {
    one(0x1, d)
}
pub fn swap(d: u16) -> u16 {
    one(0x2, d)
}
pub fn inc(d: u16) -> u16 {
    one(0x3, d)
}
pub fn asr(d: u16) -> u16 {
    one(0x5, d)
}
pub fn lsr(d: u16) -> u16 {
    one(0x6, d)
}
pub fn ror(d: u16) -> u16 {
    one(0x7, d)
}
pub fn dec(d: u16) -> u16 {
    one(0xA, d)
}
pub fn movw(d: u16, r: u16) -> u16 {
    0x0100 | ((d / 2) << 4) | (r / 2)
}
pub fn muls(d: u16, r: u16) -> u16 {
    0x0200 | ((d - 16) << 4) | (r - 16)
}
fn mul_low(base: u16, d: u16, r: u16) -> u16 {
    base | ((d - 16) << 4) | (r - 16)
}
pub fn mulsu(d: u16, r: u16) -> u16 {
    mul_low(0x0300, d, r)
}
pub fn fmul(d: u16, r: u16) -> u16 {
    mul_low(0x0308, d, r)
}
pub fn fmuls(d: u16, r: u16) -> u16 {
    mul_low(0x0380, d, r)
}
pub fn fmulsu(d: u16, r: u16) -> u16 {
    mul_low(0x0388, d, r)
}
fn word_immediate(base: u16, d: u16, k: u16) -> u16 {
    base | ((k & 0x30) << 2) | (((d - 24) / 2) << 4) | (k & 0x0F)
}
pub fn adiw(d: u16, k: u16) -> u16 {
    word_immediate(0x9600, d, k)
}
pub fn sbiw(d: u16, k: u16) -> u16 {
    word_immediate(0x9700, d, k)
}
pub fn ld_x_inc(d: u16) -> u16 {
    0x900D | (d << 4)
}
pub fn ld_y_dec(d: u16) -> u16 {
    0x900A | (d << 4)
}
pub fn st_x(r: u16) -> u16 {
    0x920C | (r << 4)
}
pub fn st_z_inc(r: u16) -> u16 {
    0x9201 | (r << 4)
}
pub fn st_y_dec(r: u16) -> u16 {
    0x920A | (r << 4)
}
/// `10q0 qq0d dddd yqqq`.
pub fn ldd(d: u16, y: bool, q: u16) -> u16 {
    0x8000 | ((q & 0x20) << 8) | ((q & 0x18) << 7) | (d << 4) | if y { 8 } else { 0 } | (q & 7)
}
pub fn std_(r: u16, y: bool, q: u16) -> u16 {
    ldd(r, y, q) | 0x0200
}
pub fn lds(d: u16, k: u16) -> [u16; 2] {
    [0x9000 | (d << 4), k]
}
pub fn sts(k: u16, r: u16) -> [u16; 2] {
    [0x9200 | (r << 4), k]
}
pub fn lpm_z(d: u16) -> u16 {
    0x9004 | (d << 4)
}
pub fn lpm_z_inc(d: u16) -> u16 {
    0x9005 | (d << 4)
}
pub fn push(r: u16) -> u16 {
    0x920F | (r << 4)
}
pub fn pop(d: u16) -> u16 {
    0x900F | (d << 4)
}
/// `1001 010k kkkk 110k` and the low sixteen bits of the word address.
pub fn jmp(k: u32) -> [u16; 2] {
    [0x940C | ((k >> 16) & 1) as u16 | (((k >> 17) & 0x1F) << 4) as u16, k as u16]
}
pub fn call(k: u32) -> [u16; 2] {
    let [first, second] = jmp(k);
    [first | 0x0002, second]
}
/// Relative jumps count words from the instruction after.
pub fn rjmp(k: i16) -> u16 {
    0xC000 | (k as u16 & 0x0FFF)
}
pub fn rcall(k: i16) -> u16 {
    0xD000 | (k as u16 & 0x0FFF)
}
/// A jump to itself: the end of a test program.
pub fn idle() -> u16 {
    rjmp(-1)
}
pub fn ret() -> u16 {
    0x9508
}
pub fn reti() -> u16 {
    0x9518
}
pub fn ijmp() -> u16 {
    0x9409
}
pub fn icall() -> u16 {
    0x9509
}
pub fn sleep() -> u16 {
    0x9588
}
/// BSET 7 and BCLR 7.
pub fn sei() -> u16 {
    0x9478
}
pub fn cli() -> u16 {
    0x94F8
}
fn branch(base: u16, s: u16, k: i8) -> u16 {
    base | ((k as u16 & 0x7F) << 3) | s
}
pub fn breq(k: i8) -> u16 {
    branch(0xF000, 1, k)
}
pub fn brne(k: i8) -> u16 {
    branch(0xF400, 1, k)
}
pub fn bst(d: u16, b: u16) -> u16 {
    0xFA00 | (d << 4) | b
}
pub fn bld(d: u16, b: u16) -> u16 {
    0xF800 | (d << 4) | b
}
pub fn sbrs(r: u16, b: u16) -> u16 {
    0xFE00 | (r << 4) | b
}
pub fn sbi(a: u16, b: u16) -> u16 {
    io_bit(0x9A00, a, b)
}
pub fn cbi(a: u16, b: u16) -> u16 {
    io_bit(0x9800, a, b)
}
pub fn sbic(a: u16, b: u16) -> u16 {
    io_bit(0x9900, a, b)
}
pub fn sbis(a: u16, b: u16) -> u16 {
    io_bit(0x9B00, a, b)
}
/// `1011 0AAd dddd AAAA`.
pub fn in_(d: u16, a: u16) -> u16 {
    0xB000 | ((a & 0x30) << 5) | (d << 4) | (a & 0x0F)
}
pub fn out(a: u16, r: u16) -> u16 {
    in_(r, a) | 0x0800
}
