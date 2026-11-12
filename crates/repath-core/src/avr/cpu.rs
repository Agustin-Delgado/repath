//! The AVRe+ instruction set, as the ATmega328P has it.
//!
//! Flags and cycle counts are the instruction set manual's for a part with a
//! 16-bit program counter and internal SRAM. An opcode the part does not have
//! (ELPM, EIJMP, the XMEGA-only ones, anything unassigned) stops the CPU with
//! a fault rather than being guessed at.

use super::machine::{C, H, I, Machine, N, PC_MASK, S, SMCR, T, V, Z};

/// Whether an opcode is the first word of a two-word instruction, which is
/// what a skip has to step over whole.
fn two_words(op: u16) -> bool {
    // LDS, STS, JMP, CALL.
    op & 0xFE0F == 0x9000 || op & 0xFE0F == 0x9200 || op & 0xFE0C == 0x940C
}

/// The X, Y and Z pointers, by the register their low byte is in.
const X: usize = 26;
const Y: usize = 28;
const ZP: usize = 30;

#[derive(Clone, Copy)]
enum Step {
    Plain,
    PostIncrement,
    PreDecrement,
}

impl Machine {
    fn flag(&self, f: u8) -> bool {
        self.sreg >> f & 1 != 0
    }

    fn set_flag(&mut self, f: u8, on: bool) {
        self.sreg = (self.sreg & !(1 << f)) | (u8::from(on) << f);
    }

    /// Replace the flags in `mask` with the bits of `values`.
    fn put_flags(&mut self, mask: u8, values: u8) {
        self.sreg = (self.sreg & !mask) | (values & mask);
    }

    fn arithmetic(&mut self, carries: u8, overflow: bool, result: u8, z: bool) {
        let n = result >> 7;
        let v = u8::from(overflow);
        let f = (carries >> 3 & 1) << H
            | (n ^ v) << S
            | v << V
            | n << N
            | u8::from(z) << Z
            | (carries >> 7) << C;
        self.put_flags(1 << H | 1 << S | 1 << V | 1 << N | 1 << Z | 1 << C, f);
    }

    /// Flags after `d + r (+ carry) = res`. The carry terms come out of the
    /// operands and the result alone, so the same expression covers ADC.
    fn add_flags(&mut self, d: u8, r: u8, res: u8) {
        let carries = (d & r) | (r & !res) | (!res & d);
        let overflow = (d & r & !res) | (!d & !r & res);
        self.arithmetic(carries, overflow >> 7 != 0, res, res == 0);
    }

    /// Flags after `d - r (- carry) = res`. With `chain`, Z can only be
    /// cleared: SBC, SBCI and CPC carry a zero result through the bytes of a
    /// wider number, so it is zero only if every byte was.
    fn sub_flags(&mut self, d: u8, r: u8, res: u8, chain: bool) {
        let borrows = (!d & r) | (r & res) | (res & !d);
        let overflow = (d & !r & !res) | (!d & r & res);
        let z = res == 0 && (!chain || self.flag(Z));
        self.arithmetic(borrows, overflow >> 7 != 0, res, z);
    }

    fn logic_flags(&mut self, res: u8) {
        let n = res >> 7;
        let f = n << S | n << N | u8::from(res == 0) << Z;
        self.put_flags(1 << S | 1 << V | 1 << N | 1 << Z, f);
    }

    /// ASR, LSR and ROR: V is N xor C, as after any shift right.
    fn shift_flags(&mut self, res: u8, carry: bool) {
        let n = res >> 7;
        let c = u8::from(carry);
        let v = n ^ c;
        let f = (n ^ v) << S | v << V | n << N | u8::from(res == 0) << Z | c << C;
        self.put_flags(1 << S | 1 << V | 1 << N | 1 << Z | 1 << C, f);
    }

    /// A product into R1:R0. The fractional ones shift it left one, and carry
    /// out the bit that falls off.
    fn product(&mut self, p: u16, fractional: bool) {
        let result = if fractional { p << 1 } else { p };
        self.set_flag(C, p >> 15 != 0);
        self.set_flag(Z, result == 0);
        self.data[0] = result as u8;
        self.data[1] = (result >> 8) as u8;
    }

    fn pointer(&self, low: usize) -> u16 {
        u16::from_le_bytes([self.data[low], self.data[low + 1]])
    }

    fn set_pointer(&mut self, low: usize, value: u16) {
        let [l, h] = value.to_le_bytes();
        self.data[low] = l;
        self.data[low + 1] = h;
    }

    /// The address an indirect access uses, updating the pointer around it.
    fn address(&mut self, pointer: usize, step: Step) -> u16 {
        let p = self.pointer(pointer);
        match step {
            Step::Plain => p,
            Step::PostIncrement => {
                self.set_pointer(pointer, p.wrapping_add(1));
                p
            }
            Step::PreDecrement => {
                let p = p.wrapping_sub(1);
                self.set_pointer(pointer, p);
                p
            }
        }
    }

    fn load(&mut self, d: usize, pointer: usize, step: Step) -> u64 {
        let a = self.address(pointer, step);
        self.data[d] = self.read(a);
        2
    }

    fn store(&mut self, r: usize, pointer: usize, step: Step) -> u64 {
        // The value is read before the pointer moves: `st X+, r26` stores
        // the old low byte of X.
        let value = self.data[r];
        let a = self.address(pointer, step);
        self.write(a, value);
        2
    }

    fn program_memory(&mut self, d: usize, increment: bool) -> u64 {
        let z = self.pointer(ZP);
        self.data[d] = self.flash_byte(z);
        if increment {
            self.set_pointer(ZP, z.wrapping_add(1));
        }
        3
    }

    /// Step over the next instruction: one cycle more for a one-word one, two
    /// for a two-word one.
    fn skip(&mut self) -> u64 {
        let words = if two_words(self.fetch(self.pc)) { 2 } else { 1 };
        self.pc = self.pc.wrapping_add(words) & PC_MASK;
        1 + u64::from(words)
    }

    fn jump_relative(&mut self, offset: i16) {
        self.pc = self.pc.wrapping_add_signed(offset) & PC_MASK;
    }

    fn unknown(&mut self, op: u16, pc: u16) -> u64 {
        self.pc = pc;
        self.fault = Some(super::machine::Fault { cycle: self.cycle, pc, opcode: op });
        0
    }

    /// Execute the instruction at the program counter. Returns its cycles.
    pub(super) fn execute(&mut self) -> u64 {
        let pc = self.pc;
        let op = self.fetch(pc);
        self.pc = pc.wrapping_add(1) & PC_MASK;
        let d = usize::from((op >> 4) & 0x1F);
        let r = usize::from((op & 0x0F) | ((op >> 5) & 0x10));
        let dh = 16 + usize::from((op >> 4) & 0x0F);
        let k = (((op >> 4) & 0xF0) | (op & 0x0F)) as u8;
        let (rd, rr) = (self.data[d], self.data[r]);
        let carry = u8::from(self.flag(C));
        match op >> 12 {
            0x0 => match (op >> 10) & 3 {
                0 => self.group_zero(op, pc),
                1 => {
                    // CPC
                    let res = rd.wrapping_sub(rr).wrapping_sub(carry);
                    self.sub_flags(rd, rr, res, true);
                    1
                }
                2 => {
                    // SBC
                    let res = rd.wrapping_sub(rr).wrapping_sub(carry);
                    self.sub_flags(rd, rr, res, true);
                    self.data[d] = res;
                    1
                }
                _ => {
                    // ADD, and LSL as ADD Rd, Rd
                    let res = rd.wrapping_add(rr);
                    self.add_flags(rd, rr, res);
                    self.data[d] = res;
                    1
                }
            },
            0x1 => match (op >> 10) & 3 {
                0 => {
                    // CPSE
                    if rd == rr { self.skip() } else { 1 }
                }
                1 => {
                    // CP
                    self.sub_flags(rd, rr, rd.wrapping_sub(rr), false);
                    1
                }
                2 => {
                    // SUB
                    let res = rd.wrapping_sub(rr);
                    self.sub_flags(rd, rr, res, false);
                    self.data[d] = res;
                    1
                }
                _ => {
                    // ADC, and ROL as ADC Rd, Rd
                    let res = rd.wrapping_add(rr).wrapping_add(carry);
                    self.add_flags(rd, rr, res);
                    self.data[d] = res;
                    1
                }
            },
            0x2 => {
                let res = match (op >> 10) & 3 {
                    0 => rd & rr,
                    1 => rd ^ rr,
                    2 => rd | rr,
                    _ => {
                        // MOV
                        self.data[d] = rr;
                        return 1;
                    }
                };
                self.logic_flags(res);
                self.data[d] = res;
                1
            }
            0x3 => {
                // CPI
                let rd = self.data[dh];
                self.sub_flags(rd, k, rd.wrapping_sub(k), false);
                1
            }
            0x4 | 0x5 => {
                // SBCI, SUBI
                let rd = self.data[dh];
                let chain = op >> 12 == 0x4;
                let res = rd.wrapping_sub(k).wrapping_sub(if chain { carry } else { 0 });
                self.sub_flags(rd, k, res, chain);
                self.data[dh] = res;
                1
            }
            0x6 | 0x7 => {
                // ORI, ANDI
                let rd = self.data[dh];
                let res = if op >> 12 == 0x6 { rd | k } else { rd & k };
                self.logic_flags(res);
                self.data[dh] = res;
                1
            }
            0x8 | 0xA => {
                // LDD and STD through Y or Z, and LD/ST through them unmoved.
                let q = (op & 7) | ((op >> 7) & 0x18) | ((op >> 8) & 0x20);
                let base = if op & 8 != 0 { self.pointer(Y) } else { self.pointer(ZP) };
                let a = base.wrapping_add(q);
                if op & 0x0200 != 0 {
                    self.write(a, rd);
                } else {
                    self.data[d] = self.read(a);
                }
                2
            }
            0x9 => self.group_nine(op, pc, d, r),
            0xB => {
                let a = 0x20 + ((op & 0x0F) | ((op >> 5) & 0x30));
                if op & 0x0800 == 0 {
                    self.data[d] = self.read(a);
                } else {
                    self.write(a, rd);
                }
                1
            }
            0xC => {
                // RJMP
                self.jump_relative(((op << 4) as i16) >> 4);
                2
            }
            0xD => {
                // RCALL
                self.push_pc(self.pc);
                self.jump_relative(((op << 4) as i16) >> 4);
                3
            }
            0xE => {
                // LDI
                self.data[dh] = k;
                1
            }
            _ => match (op >> 10) & 3 {
                0 | 1 => {
                    // BRBS and BRBC.
                    let wants = (op >> 10) & 1 == 0;
                    if self.flag((op & 7) as u8) == wants {
                        self.jump_relative(((op << 6) as i16) >> 9);
                        2
                    } else {
                        1
                    }
                }
                _ if op & 8 != 0 => self.unknown(op, pc),
                2 => {
                    let b = op & 7;
                    if op & 0x0200 == 0 {
                        // BLD
                        let t = u8::from(self.flag(T));
                        self.data[d] = (rd & !(1 << b)) | t << b;
                    } else {
                        // BST
                        self.set_flag(T, rd >> b & 1 != 0);
                    }
                    1
                }
                _ => {
                    // SBRC and SBRS.
                    let set = rd >> (op & 7) & 1 != 0;
                    if set == (op & 0x0200 != 0) { self.skip() } else { 1 }
                }
            },
        }
    }

    /// NOP, MOVW and the signed and fractional multiplies.
    fn group_zero(&mut self, op: u16, pc: u16) -> u64 {
        match (op >> 8) & 3 {
            0 => {
                if op == 0 {
                    1
                } else {
                    self.unknown(op, pc)
                }
            }
            1 => {
                // MOVW
                let d = usize::from((op >> 4) & 0x0F) * 2;
                let r = usize::from(op & 0x0F) * 2;
                self.data[d] = self.data[r];
                self.data[d + 1] = self.data[r + 1];
                1
            }
            2 => {
                // MULS
                let a = self.data[16 + usize::from((op >> 4) & 0x0F)] as i8;
                let b = self.data[16 + usize::from(op & 0x0F)] as i8;
                self.product((i16::from(a) * i16::from(b)) as u16, false);
                2
            }
            _ => {
                let a = self.data[16 + usize::from((op >> 4) & 7)];
                let b = self.data[16 + usize::from(op & 7)];
                let (signed, unsigned) = (i16::from(a as i8), i16::from(b));
                let p = match (op >> 7 & 1, op >> 3 & 1) {
                    // MULSU
                    (0, 0) => return self.multiply((signed * unsigned) as u16, false),
                    // FMUL
                    (0, _) => u16::from(a) * u16::from(b),
                    // FMULS
                    (_, 0) => (signed * i16::from(b as i8)) as u16,
                    // FMULSU
                    _ => (signed * unsigned) as u16,
                };
                self.multiply(p, true)
            }
        }
    }

    fn multiply(&mut self, p: u16, fractional: bool) -> u64 {
        self.product(p, fractional);
        2
    }

    /// Everything under 1001: loads and stores, one-operand arithmetic, the
    /// flag instructions, jumps and calls, ADIW and SBIW, the I/O bit
    /// instructions and MUL.
    fn group_nine(&mut self, op: u16, pc: u16, d: usize, r: usize) -> u64 {
        let rd = self.data[d];
        match (op >> 9) & 7 {
            0 => match op & 0x0F {
                0x0 => {
                    // LDS
                    let a = self.fetch(self.pc);
                    self.pc = self.pc.wrapping_add(1) & PC_MASK;
                    self.data[d] = self.read(a);
                    2
                }
                0x1 => self.load(d, ZP, Step::PostIncrement),
                0x2 => self.load(d, ZP, Step::PreDecrement),
                0x4 => self.program_memory(d, false),
                0x5 => self.program_memory(d, true),
                0x9 => self.load(d, Y, Step::PostIncrement),
                0xA => self.load(d, Y, Step::PreDecrement),
                0xC => self.load(d, X, Step::Plain),
                0xD => self.load(d, X, Step::PostIncrement),
                0xE => self.load(d, X, Step::PreDecrement),
                0xF => {
                    // POP
                    self.data[d] = self.pop();
                    2
                }
                _ => self.unknown(op, pc),
            },
            1 => match op & 0x0F {
                0x0 => {
                    // STS
                    let a = self.fetch(self.pc);
                    self.pc = self.pc.wrapping_add(1) & PC_MASK;
                    self.write(a, rd);
                    2
                }
                0x1 => self.store(d, ZP, Step::PostIncrement),
                0x2 => self.store(d, ZP, Step::PreDecrement),
                0x9 => self.store(d, Y, Step::PostIncrement),
                0xA => self.store(d, Y, Step::PreDecrement),
                0xC => self.store(d, X, Step::Plain),
                0xD => self.store(d, X, Step::PostIncrement),
                0xE => self.store(d, X, Step::PreDecrement),
                0xF => {
                    // PUSH
                    self.push(rd);
                    2
                }
                _ => self.unknown(op, pc),
            },
            2 => self.one_operand(op, pc, d),
            3 => {
                // ADIW and SBIW, on the pairs from R25:R24 up.
                let p = 24 + 2 * usize::from((op >> 4) & 3);
                let k = (op & 0x0F) | ((op >> 2) & 0x30);
                let value = self.pointer(p);
                let high = value >> 15 != 0;
                let res;
                let (overflow, carry);
                if op & 0x0100 == 0 {
                    res = value.wrapping_add(k);
                    let r15 = res >> 15 != 0;
                    overflow = !high && r15;
                    carry = !r15 && high;
                } else {
                    res = value.wrapping_sub(k);
                    let r15 = res >> 15 != 0;
                    overflow = high && !r15;
                    carry = r15 && !high;
                }
                self.set_pointer(p, res);
                let n = res >> 15 != 0;
                self.set_flag(V, overflow);
                self.set_flag(N, n);
                self.set_flag(S, n ^ overflow);
                self.set_flag(Z, res == 0);
                self.set_flag(C, carry);
                2
            }
            4 | 5 => {
                let a = 0x20 + ((op >> 3) & 0x1F);
                let b = (op & 7) as u8;
                match (op >> 8) & 3 {
                    0 => {
                        // CBI
                        self.write_bit(a, b, false);
                        2
                    }
                    2 => {
                        // SBI
                        self.write_bit(a, b, true);
                        2
                    }
                    which => {
                        // SBIC and SBIS.
                        let set = self.read(a) >> b & 1 != 0;
                        if set == (which == 3) { self.skip() } else { 1 }
                    }
                }
            }
            _ => {
                // MUL
                let p = u16::from(rd) * u16::from(self.data[r]);
                self.multiply(p, false)
            }
        }
    }

    /// 1001 010x: one-operand arithmetic, SREG bits, returns, jumps and calls.
    fn one_operand(&mut self, op: u16, pc: u16, d: usize) -> u64 {
        let rd = self.data[d];
        match op & 0x0F {
            0x0 => {
                // COM
                let res = !rd;
                self.logic_flags(res);
                self.set_flag(C, true);
                self.data[d] = res;
                1
            }
            0x1 => {
                // NEG: the same flags as 0 - Rd.
                let res = 0u8.wrapping_sub(rd);
                self.sub_flags(0, rd, res, false);
                self.data[d] = res;
                1
            }
            0x2 => {
                // SWAP
                self.data[d] = rd.rotate_left(4);
                1
            }
            0x3 | 0xA => {
                // INC and DEC: C and H stay; V only on crossing 0x7F/0x80.
                let (res, overflow) = if op & 0x0F == 0x3 {
                    let res = rd.wrapping_add(1);
                    (res, res == 0x80)
                } else {
                    let res = rd.wrapping_sub(1);
                    (res, res == 0x7F)
                };
                let n = res >> 7 != 0;
                self.set_flag(V, overflow);
                self.set_flag(N, n);
                self.set_flag(S, n ^ overflow);
                self.set_flag(Z, res == 0);
                self.data[d] = res;
                1
            }
            0x5 => {
                // ASR
                let res = ((rd as i8) >> 1) as u8;
                self.shift_flags(res, rd & 1 != 0);
                self.data[d] = res;
                1
            }
            0x6 => {
                // LSR
                let res = rd >> 1;
                self.shift_flags(res, rd & 1 != 0);
                self.data[d] = res;
                1
            }
            0x7 => {
                // ROR
                let res = rd >> 1 | u8::from(self.flag(C)) << 7;
                self.shift_flags(res, rd & 1 != 0);
                self.data[d] = res;
                1
            }
            0x8 if op & 0x0100 == 0 => {
                // BSET and BCLR: SEC, CLI and the rest.
                let s = ((op >> 4) & 7) as u8;
                let set = op & 0x80 == 0;
                self.set_flag(s, set);
                if s == I && set {
                    self.inhibit = true;
                }
                1
            }
            0x8 => match (op >> 4) & 0x0F {
                0x0 => {
                    // RET
                    self.pc = self.pop_pc();
                    4
                }
                0x1 => {
                    // RETI
                    self.pc = self.pop_pc();
                    self.set_flag(I, true);
                    self.inhibit = true;
                    4
                }
                0x8 => {
                    // SLEEP, if SMCR's sleep enable is set.
                    if self.data[usize::from(SMCR)] & 1 != 0 {
                        self.sleeping = true;
                    }
                    1
                }
                // BREAK (no debugger to stop for) and WDR (no watchdog).
                0x9 | 0xA => 1,
                0xC => self.program_memory(0, false),
                // SPM: the flash is not written.
                0xE => 1,
                _ => self.unknown(op, pc),
            },
            0x9 => match op {
                0x9409 => {
                    // IJMP
                    self.pc = self.pointer(ZP) & PC_MASK;
                    2
                }
                0x9509 => {
                    // ICALL
                    self.push_pc(self.pc);
                    self.pc = self.pointer(ZP) & PC_MASK;
                    3
                }
                _ => self.unknown(op, pc),
            },
            0xC..=0xF => {
                // JMP and CALL: 22 bits of address, of which this part has 14.
                let high = ((op >> 3) & 0x3E) | (op & 1);
                let low = self.fetch(self.pc);
                let target = ((u32::from(high) << 16 | u32::from(low)) as u16) & PC_MASK;
                if op & 0x02 == 0 {
                    self.pc = target;
                    3
                } else {
                    self.push_pc(self.pc.wrapping_add(1) & PC_MASK);
                    self.pc = target;
                    4
                }
            }
            _ => self.unknown(op, pc),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::asm::*;
    use super::super::machine::tests::{machine, run_to};
    use super::super::machine::{Machine, RAMEND, Watch};
    use super::*;

    const FLAGS: [(char, u8); 8] =
        [('I', I), ('T', T), ('H', H), ('S', S), ('V', V), ('N', N), ('Z', Z), ('C', C)];

    /// SREG as the manual writes it, a letter for each flag that is set.
    fn flags(m: &Machine) -> String {
        FLAGS.iter().filter(|(_, bit)| m.sreg >> bit & 1 != 0).map(|(c, _)| *c).collect()
    }

    /// Execute one instruction and return its cycles.
    fn step(m: &mut Machine) -> u64 {
        let before = m.cycle;
        let _ = m.run(m.cycle + 1, &Watch::default());
        assert!(m.fault.is_none(), "{m:?}");
        m.cycle - before
    }

    /// Run `op` on R16 = `d`, R17 = `r` with SREG = `sreg`; returns R16 and
    /// the flags.
    fn alu(op: u16, d: u8, r: u8, sreg: u8) -> (u8, String) {
        let mut m = machine(&[op]);
        m.data[16] = d;
        m.data[17] = r;
        m.sreg = sreg;
        step(&mut m);
        (m.data[16], flags(&m))
    }

    #[test]
    fn add_sets_half_carry_overflow_and_carry_by_the_manual() {
        // 0x0F + 0x01: a carry out of bit 3 and nothing else.
        assert_eq!(alu(add(16, 17), 0x0F, 0x01, 0), (0x10, "H".into()));
        // 0x7F + 0x01: two positives make a negative, so V; N and V cancel in S.
        assert_eq!(alu(add(16, 17), 0x7F, 0x01, 0), (0x80, "HVN".into()));
        // 0xFF + 0x01: wraps to zero with both carries.
        assert_eq!(alu(add(16, 17), 0xFF, 0x01, 0), (0x00, "HZC".into()));
        // 0x80 + 0x80: two negatives make zero: V and C, and S = N ^ V = 1.
        assert_eq!(alu(add(16, 17), 0x80, 0x80, 0), (0x00, "SVZC".into()));
        // ADC brings the carry in: 0x7F + 0x00 + C overflows like 0x7F + 1.
        assert_eq!(alu(adc(16, 17), 0x7F, 0x00, 1 << C), (0x80, "HVN".into()));
    }

    #[test]
    fn sub_and_cp_borrow_by_the_manual() {
        // 0x00 - 0x01: borrows from both bit 3 and bit 7; negative, no overflow.
        assert_eq!(alu(sub(16, 17), 0x00, 0x01, 0), (0xFF, "HSNC".into()));
        // 0x80 - 0x01: the most negative number minus one overflows.
        assert_eq!(alu(sub(16, 17), 0x80, 0x01, 0), (0x7F, "HSV".into()));
        // CP leaves the register alone.
        assert_eq!(alu(cp(16, 17), 0x05, 0x05, 0), (0x05, "Z".into()));
        // SBC subtracts the carry too.
        assert_eq!(alu(sbc(16, 17), 0x05, 0x04, 1 << C), (0x00, "".into()));
    }

    #[test]
    fn a_chained_compare_only_ever_clears_z() {
        // 0x0100 against 0x0000, a byte at a time: CP on the low bytes finds
        // them equal (Z set), then CPC on the high bytes 0x01 - 0x00 clears it.
        assert_eq!(alu(cpc(16, 17), 0x01, 0x00, 1 << Z).1, "");
        // 0x0001 against 0x0000: the low bytes differ, so Z is clear going
        // in, and CPC of equal high bytes must not set it.
        assert_eq!(alu(cpc(16, 17), 0x00, 0x00, 0).1, "");
        // Equal throughout: Z survives.
        assert_eq!(alu(cpc(16, 17), 0x00, 0x00, 1 << Z).1, "Z");
        // SBCI the same: 0x12 - 0x12 - 0 with Z clear going in stays clear.
        let mut m = machine(&[sbci(16, 0x12)]);
        m.data[16] = 0x12;
        step(&mut m);
        assert_eq!((m.data[16], flags(&m)), (0, "".into()));
    }

    #[test]
    fn neg_inc_and_dec_overflow_where_the_manual_says() {
        // NEG 0x80 is 0x80 again: the one value whose negation overflows.
        assert_eq!(alu(neg(16), 0x80, 0, 0), (0x80, "VNC".into()));
        assert_eq!(alu(neg(16), 0x00, 0, 0), (0x00, "Z".into()));
        // NEG 0x01: a borrow out of bit 3 and bit 7.
        assert_eq!(alu(neg(16), 0x01, 0, 0), (0xFF, "HSNC".into()));
        // INC and DEC never touch C or H.
        assert_eq!(alu(inc(16), 0x7F, 0, 1 << C | 1 << H), (0x80, "HVNC".into()));
        assert_eq!(alu(inc(16), 0xFF, 0, 0), (0x00, "Z".into()));
        assert_eq!(alu(dec(16), 0x80, 0, 0), (0x7F, "SV".into()));
        assert_eq!(alu(dec(16), 0x01, 0, 1 << C), (0x00, "ZC".into()));
    }

    #[test]
    fn com_sets_carry_and_logic_clears_overflow() {
        assert_eq!(alu(com(16), 0x0F, 0, 1 << V), (0xF0, "SNC".into()));
        assert_eq!(alu(and(16, 17), 0xF0, 0x0F, 1 << V | 1 << C), (0x00, "ZC".into()));
        assert_eq!(alu(eor(16, 17), 0xFF, 0x7F, 0), (0x80, "SN".into()));
    }

    #[test]
    fn shifts_put_bit_zero_in_carry_and_n_xor_c_in_v() {
        // ASR keeps the sign: 0x81 -> 0xC0, C = 1, N = 1, V = 0, S = 1.
        assert_eq!(alu(asr(16), 0x81, 0, 0), (0xC0, "SNC".into()));
        // LSR always clears N, so V = C and S = V.
        assert_eq!(alu(lsr(16), 0x01, 0, 0), (0x00, "SVZC".into()));
        // ROR brings the old carry into bit 7.
        assert_eq!(alu(ror(16), 0x02, 0, 1 << C), (0x81, "VN".into()));
        // SWAP exchanges the nibbles and touches nothing else.
        assert_eq!(alu(swap(16), 0x3C, 0, 0), (0xC3, "".into()));
    }

    #[test]
    fn adiw_and_sbiw_work_on_the_pair() {
        let word = |op: u16, value: u16| {
            let mut m = machine(&[op]);
            m.set_pointer(24, value);
            let cycles = step(&mut m);
            (m.pointer(24), flags(&m), cycles)
        };
        assert_eq!(word(adiw(24, 1), 0xFFFF), (0x0000, "ZC".into(), 2));
        assert_eq!(word(adiw(24, 1), 0x7FFF), (0x8000, "VN".into(), 2));
        assert_eq!(word(adiw(24, 63), 0x0100), (0x013F, "".into(), 2));
        assert_eq!(word(sbiw(24, 1), 0x0000), (0xFFFF, "SNC".into(), 2));
        assert_eq!(word(sbiw(24, 1), 0x8000), (0x7FFF, "SV".into(), 2));
        assert_eq!(word(sbiw(24, 1), 0x0001), (0x0000, "Z".into(), 2));
    }

    #[test]
    fn the_multiplies_put_the_product_in_r1_r0() {
        let mul = |op: u16, a: u8, b: u8| {
            let mut m = machine(&[op]);
            m.data[16] = a;
            m.data[17] = b;
            let cycles = step(&mut m);
            (u16::from_le_bytes([m.data[0], m.data[1]]), flags(&m), cycles)
        };
        assert_eq!(mul(mul_(16, 17), 0xFF, 0xFF), (0xFE01, "C".into(), 2));
        assert_eq!(mul(mul_(16, 17), 0x00, 0x7F), (0x0000, "Z".into(), 2));
        // -1 * -1, and -128 * 127.
        assert_eq!(mul(muls(16, 17), 0xFF, 0xFF), (0x0001, "".into(), 2));
        assert_eq!(mul(muls(16, 17), 0x80, 0x7F), ((-16256i16) as u16, "C".into(), 2));
        // MULSU: -1 (signed) * 255 (unsigned) = -255.
        assert_eq!(mul(mulsu(16, 17), 0xFF, 0xFF), ((-255i16) as u16, "C".into(), 2));
        // FMUL in 1.7 by 1.7: 1.0 * 1.0 is 1.0 in 1.15, 0x8000.
        assert_eq!(mul(fmul(16, 17), 0x80, 0x80), (0x8000, "".into(), 2));
        // FMULS 0.5 * 0.5 = 0.25, 0x2000; and -1 * -1, which overflows to -1.
        assert_eq!(mul(fmuls(16, 17), 0x40, 0x40), (0x2000, "".into(), 2));
        assert_eq!(mul(fmuls(16, 17), 0x80, 0x80), (0x8000, "".into(), 2));
        // FMULSU -0.5 * 1.0 (unsigned 0x80): -0.5 in 1.15 is 0xC000.
        assert_eq!(mul(fmulsu(16, 17), 0xC0, 0x80), (0xC000, "C".into(), 2));
    }

    #[test]
    fn every_addressing_mode_moves_its_pointer_the_right_way() {
        let mut m = machine(&[
            ld_x_inc(16), // r16 <- (X), X++
            ld_y_dec(17), // Y--, r17 <- (Y)
            ldd(18, true, 5),
            ldd(19, false, 63),
            st_x(20), // (X) <- r20
            st_z_inc(21),
            st_y_dec(22),
            std_(23, false, 2),
        ]);
        for (i, byte) in m.data[0x200..0x240].iter_mut().enumerate() {
            *byte = i as u8;
        }
        m.set_pointer(26, 0x0210);
        m.set_pointer(28, 0x0220);
        m.set_pointer(30, 0x0200);
        m.data[20..24].copy_from_slice(&[0xA0, 0xA1, 0xA2, 0xA3]);
        for _ in 0..8 {
            assert_eq!(step(&mut m), 2);
        }
        assert_eq!(m.data[16], 0x10);
        assert_eq!(m.data[17], 0x1F);
        assert_eq!(m.data[18], 0x24, "Y (now 0x21F) + 5");
        assert_eq!(m.data[19], 0x3F, "Z + 63");
        assert_eq!(m.data[0x211], 0xA0, "X had moved on to 0x211");
        assert_eq!(m.data[0x200], 0xA1);
        assert_eq!(m.data[0x21E], 0xA2);
        assert_eq!(m.data[0x203], 0xA3, "Z (now 0x201) + 2");
        assert_eq!(m.pointer(26), 0x0211);
        assert_eq!(m.pointer(28), 0x021E);
        assert_eq!(m.pointer(30), 0x0201);
    }

    #[test]
    fn lds_sts_and_lpm_reach_their_memories() {
        let program = [
            lds(16, 0x0300)[0],
            0x0300,
            sts(0x0301, 16)[0],
            0x0301,
            ldi(30, 16), // Z = byte 16 of flash: the low byte of word 8
            ldi(31, 0),
            lpm_z_inc(17),
            lpm_z(18),
            0xBEEF,
        ];
        let mut m = machine(&program);
        m.data[0x300] = 0x5A;
        assert_eq!(step(&mut m), 2);
        assert_eq!(step(&mut m), 2);
        assert_eq!(m.data[0x301], 0x5A);
        step(&mut m);
        step(&mut m);
        // Word 8 is 0xBEEF, little-endian in the byte-addressed view LPM has.
        assert_eq!(step(&mut m), 3);
        assert_eq!(m.data[17], 0xEF);
        assert_eq!(m.pointer(30), 17);
        assert_eq!(step(&mut m), 3);
        assert_eq!(m.data[18], 0xBE);
    }

    #[test]
    fn call_stacks_the_return_address_low_byte_highest() {
        // call 0x0010 at word 0; the return address is word 2.
        let mut program = vec![0; 0x12];
        program[..2].copy_from_slice(&call(0x0010));
        program[0x10] = ret();
        let mut m = machine(&program);
        assert_eq!(step(&mut m), 4);
        assert_eq!(m.pc, 0x10);
        assert_eq!(m.sp, RAMEND - 2);
        assert_eq!(m.data[usize::from(RAMEND)], 0x02, "low byte at the top");
        assert_eq!(m.data[usize::from(RAMEND - 1)], 0x00);
        assert_eq!(step(&mut m), 4);
        assert_eq!((m.pc, m.sp), (2, RAMEND));
    }

    #[test]
    fn relative_and_indirect_calls_take_three_cycles() {
        let mut program = vec![0; 0x30];
        program[0] = rcall(0x20 - 1); // to word 0x20
        program[0x20] = ijmp();
        let mut m = machine(&program);
        assert_eq!(step(&mut m), 3);
        assert_eq!(m.pc, 0x20);
        assert_eq!(m.data[usize::from(RAMEND)], 0x01);
        m.set_pointer(30, 0x0005);
        assert_eq!(step(&mut m), 2);
        assert_eq!(m.pc, 5);

        let mut program = vec![0; 0x10];
        program[0] = icall();
        let mut m = machine(&program);
        m.set_pointer(30, 0x0008);
        assert_eq!(step(&mut m), 3);
        assert_eq!(m.pc, 8);
        assert_eq!(m.pop_pc(), 1);
    }

    #[test]
    fn a_skip_steps_over_a_whole_two_word_instruction() {
        // cpse r0, r0 always skips. Over a one-word instruction: 2 cycles;
        // over JMP, CALL, LDS or STS: 3, landing past their second word.
        for (second, words) in [
            (vec![nop()], 1),
            (jmp(0x100).to_vec(), 2),
            (call(0x100).to_vec(), 2),
            (lds(0, 0x100).to_vec(), 2),
            (sts(0x100, 0).to_vec(), 2),
        ] {
            let mut program = vec![cpse(0, 0)];
            program.extend(&second);
            program.push(nop());
            let mut m = machine(&program);
            assert_eq!(step(&mut m), 1 + words, "{second:04x?}");
            assert_eq!(m.pc, 1 + words as u16);
        }
        // Not skipping costs one cycle, whatever comes next.
        let mut program = vec![cpse(0, 1)];
        program.extend(jmp(0x100));
        let mut m = machine(&program);
        m.data[1] = 1;
        assert_eq!(step(&mut m), 1);
        assert_eq!(m.pc, 1);
        // SBRS and SBIC the same.
        let mut program = vec![sbrs(16, 3)];
        program.extend(lds(0, 0x100));
        let mut m = machine(&program);
        m.data[16] = 0x08;
        assert_eq!(step(&mut m), 3);
        let mut program = vec![sbic(0x05, 0)];
        program.extend(sts(0x100, 0));
        let mut m = machine(&program);
        assert_eq!(step(&mut m), 3);
    }

    #[test]
    fn a_branch_costs_two_cycles_taken_and_one_not() {
        let mut m = machine(&[breq(5)]);
        m.sreg = 1 << Z;
        assert_eq!(step(&mut m), 2);
        assert_eq!(m.pc, 6);
        let mut m = machine(&[breq(5)]);
        assert_eq!(step(&mut m), 1);
        assert_eq!(m.pc, 1);
        let mut m = machine(&[nop(), nop(), brne(-3)]);
        m.pc = 2;
        assert_eq!(step(&mut m), 2);
        assert_eq!(m.pc, 0);
    }

    #[test]
    fn push_pop_movw_and_the_t_flag() {
        let mut m =
            machine(&[push(16), pop(17), movw(2, 16), bst(16, 7), bld(18, 0), sei(), cli()]);
        m.data[16] = 0x80;
        m.data[17] = 0x01;
        assert_eq!(step(&mut m), 2);
        assert_eq!(m.data[usize::from(RAMEND)], 0x80);
        assert_eq!(step(&mut m), 2);
        assert_eq!((m.data[17], m.sp), (0x80, RAMEND));
        assert_eq!(step(&mut m), 1);
        assert_eq!(&m.data[2..4], &[0x80, 0x80]);
        step(&mut m);
        assert_eq!(flags(&m), "T");
        step(&mut m);
        assert_eq!(m.data[18], 0x01);
        step(&mut m);
        assert_eq!(flags(&m), "IT");
        step(&mut m);
        assert_eq!(flags(&m), "T");
    }

    #[test]
    fn an_unknown_opcode_stops_the_cpu_and_says_where() {
        // 0x95D8 is ELPM, which needs a RAMPZ this part does not have.
        let mut m = machine(&[nop(), 0x95D8]);
        let stop = m.run(100, &Watch::default());
        assert_eq!(stop, super::super::machine::Stop::Fault(1));
        let fault = m.fault.unwrap();
        assert_eq!((fault.pc, fault.opcode), (1, 0x95D8));
        assert_eq!(fault.to_string(), "unknown instruction 0x95D8 at 0x0002");
        // It stays stopped.
        assert_eq!(m.run(200, &Watch::default()), super::super::machine::Stop::Idle);

        let mut m = machine(&[nop()]);
        m.run(100, &Watch::default());
        assert_eq!(m.fault.unwrap().to_string(), "the program ran into erased flash at 0x0002");
    }

    #[test]
    fn an_interrupt_takes_four_cycles_and_reti_lets_one_instruction_through() {
        // Timer0 overflow (vector 16, word 32) from TCNT0 = 0xFF at prescaler
        // 1, so the flag rises on the first timer clock.
        let mut program = vec![nop(); 40];
        program[0] = ldi(16, 1);
        program[1] = sts(0x6E, 16)[0]; // TIMSK0 = TOIE0
        program[2] = 0x006E;
        program[3] = ldi(16, 0xFF);
        program[4] = out(0x26, 16); // TCNT0 = 0xFF
        program[5] = out(0x25, 17); // TCCR0B = r17 = 1: start, prescaler 1
        program[6] = sei();
        program[7] = nop(); // runs: SEI lets one instruction through
        program[8] = nop();
        program[32] = reti();
        let mut m = machine(&program);
        m.data[17] = 1;
        // ldi 1, sts 2, ldi 1, out 1: the timer starts on the cycle `out
        // TCCR0B` begins, 5, and the first clock at 6 takes it from 0xFF to 0
        // and raises TOV0. Interrupts stay off until SEI (cycle 6..7), and the
        // NOP after it runs (7..8) before the vector is taken.
        assert_eq!(run_to(&mut m, 8, 100), 8);
        assert_eq!(m.pc, 8);
        step(&mut m);
        assert_eq!(m.pc, 32, "the vector, after the four-cycle response");
        assert_eq!(m.cycle, 12);
        assert_eq!(flags(&m), "", "I is cleared on entry");
        assert_eq!(m.read(0x35) & 1, 0, "and TOV0 by the hardware");
        assert_eq!(step(&mut m), 4);
        assert_eq!((m.pc, flags(&m)), (8, "I".into()));
    }

    #[test]
    fn the_lowest_vector_wins() {
        // Timer0 compare A (14) and overflow (16) both pending: A first.
        let mut program = vec![nop(); 40];
        program[0] = sei();
        let mut m = machine(&program);
        m.raise_timer_flags(0, 0x03);
        m.write(0x6E, 0x03);
        // SEI, then the one instruction it lets through, then the vector.
        step(&mut m);
        step(&mut m);
        step(&mut m);
        assert_eq!(m.pc, 28);
    }
}
