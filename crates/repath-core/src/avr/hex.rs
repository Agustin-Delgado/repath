//! Intel HEX, the format every AVR toolchain hands a program over in.

use std::fmt;

/// A HEX file that cannot be loaded, and the line that says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HexError {
    /// One-based, counting blank lines, so it matches an editor's gutter.
    pub line: usize,
    pub reason: String,
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.reason)
    }
}

impl std::error::Error for HexError {}

/// What a byte nobody programmed reads as: an erased flash cell is all ones.
pub const ERASED: u8 = 0xFF;

/// The bytes a HEX file puts in memory, from address zero up to the last one
/// it writes; gaps read as [`ERASED`].
///
/// `capacity` is checked record by record, so a file for a bigger part fails
/// on the line that does not fit rather than allocating whatever an address
/// record asks for.
///
/// Data, end-of-file and both kinds of extended address record are
/// understood. Start-address records are accepted and ignored: they say where
/// a debugger should begin, and an AVR always begins at its reset vector. A
/// file without an end-of-file record is refused, since that is what a paste
/// cut short looks like.
pub fn parse(text: &str, capacity: usize) -> Result<Vec<u8>, HexError> {
    let mut image = Vec::new();
    let mut base = 0usize;
    let mut lines = 0;
    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        lines = line;
        let record = raw.trim();
        if record.is_empty() {
            continue;
        }
        let fail = |reason: String| HexError { line, reason };
        let Some(digits) = record.strip_prefix(':') else {
            return Err(fail("a record has to start with ':'".into()));
        };
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(fail("a record is hexadecimal digits after the ':'".into()));
        }
        if digits.len() % 2 != 0 || digits.len() < 10 {
            return Err(fail("the record is too short or has half a byte".into()));
        }
        let bytes: Vec<u8> = (0..digits.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).unwrap_or(0))
            .collect();
        let count = bytes[0] as usize;
        if bytes.len() != count + 5 {
            return Err(fail(format!(
                "the record says it carries {count} bytes but has {}",
                bytes.len().saturating_sub(5)
            )));
        }
        // Every byte of a record, its checksum included, adds up to zero.
        let sum = bytes.iter().fold(0u8, |a, b| a.wrapping_add(*b));
        if sum != 0 {
            let given = bytes[bytes.len() - 1];
            let expected = given.wrapping_sub(sum);
            return Err(fail(format!(
                "the checksum is {given:02X} where the record needs {expected:02X}"
            )));
        }
        let address = usize::from(u16::from_be_bytes([bytes[1], bytes[2]]));
        let data = &bytes[4..4 + count];
        match bytes[3] {
            0x00 => {
                let start = base + address;
                let end = start + count;
                if end > capacity {
                    return Err(fail(format!(
                        "bytes 0x{start:X} to 0x{:X} do not fit in {capacity} bytes",
                        end - 1
                    )));
                }
                if image.len() < end {
                    image.resize(end, ERASED);
                }
                image[start..end].copy_from_slice(data);
            }
            0x01 => return Ok(image),
            kind @ (0x02 | 0x04) => {
                if count != 2 {
                    return Err(fail("an extended address record carries two bytes".into()));
                }
                let value = usize::from(u16::from_be_bytes([data[0], data[1]]));
                base = if kind == 0x02 { value << 4 } else { value << 16 };
            }
            0x03 | 0x05 => {}
            other => {
                return Err(fail(format!("record type {other:02X} is not one Intel HEX has")));
            }
        }
    }
    Err(HexError {
        line: lines.max(1),
        reason: "there is no end-of-file record; the file may have been cut short".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_lands_at_its_address_and_gaps_read_erased() {
        // 04 + 00 + 02 + 00 + 01 + 02 + 03 + 04 = 0x10, so the checksum is F0.
        let image = parse(":0400020001020304F0\n:00000001FF\n", 64).unwrap();
        assert_eq!(image, vec![0xFF, 0xFF, 1, 2, 3, 4]);
    }

    #[test]
    fn a_record_out_of_a_real_build_reads_as_its_vector_table() {
        // The first line of an Arduino blink build: four `jmp` instructions,
        // 0x940C and their target, each little-endian.
        let text = ":100000000C945C000C946E000C946E000C946E00CA\n:00000001FF\n";
        let image = parse(text, 32 * 1024).unwrap();
        assert_eq!(&image[..4], &[0x0C, 0x94, 0x5C, 0x00]);
        assert_eq!(image.len(), 16);
    }

    #[test]
    fn a_wrong_checksum_is_refused_with_its_line() {
        let err = parse("\n:0400000001020304F3\n:00000001FF\n", 64).unwrap_err();
        assert_eq!(err.line, 2);
        assert!(err.reason.contains("checksum"), "{err}");
    }

    #[test]
    fn extended_addresses_move_the_base() {
        // Linear: 02 + 04 + 00 + 01 = 07, checksum F9, base 0x10000.
        let text = ":020000040001F9\n:0100000055AA\n:00000001FF\n";
        let image = parse(text, 0x20000).unwrap();
        assert_eq!(image.len(), 0x10001);
        assert_eq!(image[0x10000], 0x55);
        // Segment: 02 + 02 + 10 + 00 = 14, checksum EC, base 0x1000 << 4.
        let text = ":020000021000EC\n:0100030055A7\n:00000001FF\n";
        let image = parse(text, 0x20000).unwrap();
        assert_eq!(image[0x10003], 0x55);
    }

    #[test]
    fn data_past_the_capacity_is_refused_on_its_line() {
        let text = ":020000040001F9\n:0100000055AA\n:00000001FF\n";
        let err = parse(text, 32 * 1024).unwrap_err();
        assert_eq!(err.line, 2);
    }

    #[test]
    fn the_end_of_file_record_ends_it_and_is_required() {
        // Anything after the EOF record is not read, valid or not.
        let image = parse(":0100000055AA\n:00000001FF\nnot hex at all\n", 64).unwrap();
        assert_eq!(image, vec![0x55]);
        let err = parse(":0100000055AA\n", 64).unwrap_err();
        assert!(err.reason.contains("end-of-file"), "{err}");
    }

    #[test]
    fn malformed_records_say_what_is_wrong() {
        assert!(parse("0100000055AA\n", 64).unwrap_err().reason.contains("':'"));
        assert!(parse(":01000000GGAA\n", 64).is_err());
        assert!(parse(":0200000055AA\n", 64).unwrap_err().reason.contains("carries"));
        assert!(parse(":00000007F9\n", 64).unwrap_err().reason.contains("type"));
    }
}
