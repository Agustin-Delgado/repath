//! End-to-end checks against circuits whose answers are known independently —
//! from closed-form analysis, from the device equations, or from what the part
//! is supposed to do. These are the tests that would catch a sign error in a
//! stamp, which the unit tests cannot.

use repath_core::digital::Logic;
use repath_core::prelude::*;

/// Value of an unknown at a given time, linearly interpolated between the two
/// bracketing timepoints.
fn value_at(result: &TransientResult, index: usize, t: f64) -> f64 {
    let times = &result.time;
    if times.is_empty() {
        return 0.0;
    }
    match times.binary_search_by(|probe| probe.total_cmp(&t)) {
        Ok(i) => result.solution[i][index],
        Err(0) => result.solution[0][index],
        Err(i) if i >= times.len() => result.solution[times.len() - 1][index],
        Err(i) => {
            let (t0, t1) = (times[i - 1], times[i]);
            let (v0, v1) = (result.solution[i - 1][index], result.solution[i][index]);
            let alpha = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
            v0 + (v1 - v0) * alpha
        }
    }
}

fn index_of(result: &TransientResult, name: &str) -> usize {
    result.index_of(name).unwrap_or_else(|| panic!("no unknown named {name}"))
}

fn extremes(result: &TransientResult, index: usize) -> (f64, f64) {
    result
        .signal(index)
        .into_iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)))
}

/// A step that starts at zero so the operating point sees an uncharged circuit.
fn step(v: f64) -> Waveform {
    Waveform::Pulse {
        v1: 0.0,
        v2: v,
        delay: 0.0,
        rise: 1e-12,
        fall: 1e-12,
        width: 1e9,
        period: 0.0,
    }
}

// ---------------------------------------------------------------------------
// Analog: linear
// ---------------------------------------------------------------------------

#[test]
fn resistive_divider_matches_the_ratio() {
    let mut c = Circuit::new();
    let a = c.node("a");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 12.0)));
    c.add(Box::new(Resistor::new("R1", a, out, 2_000.0)));
    c.add(Box::new(Resistor::new("R2", out, Circuit::GROUND, 1_000.0)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let i = op.unknown_names.iter().position(|n| n == "v(out)").unwrap();
    assert!((op.solution[i] - 4.0).abs() < 1e-6, "got {}", op.solution[i]);
}

#[test]
fn voltage_source_current_has_the_right_sign() {
    // 10 V across 1 kΩ draws 10 mA *out* of the source's positive terminal, which
    // in MNA shows up as a negative branch current.
    let mut c = Circuit::new();
    let a = c.node("a");
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 10.0)));
    c.add(Box::new(Resistor::new("R1", a, Circuit::GROUND, 1_000.0)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let i = op.unknown_names.iter().position(|n| n == "i(V1)").unwrap();
    assert!((op.solution[i] + 0.01).abs() < 1e-6, "got {}", op.solution[i]);
}

#[test]
fn rc_step_response_follows_the_exponential() {
    let (r, cap) = (1_000.0, 1e-6);
    let tau = r * cap;

    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::new("V1", vin, Circuit::GROUND, step(5.0))));
    c.add(Box::new(Resistor::new("R1", vin, out, r)));
    c.add(Box::new(Capacitor::new("C1", out, Circuit::GROUND, cap)));

    let mut cfg = TransientConfig::new(5.0 * tau);
    cfg.max_step = tau / 50.0;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();
    let out = index_of(&result, "v(out)");

    for k in [0.5f64, 1.0, 2.0, 3.0] {
        let t = k * tau;
        let expected = 5.0 * (1.0 - (-k).exp());
        let actual = value_at(&result, out, t);
        assert!(
            (actual - expected).abs() < 0.01 * 5.0,
            "at t = {k} tau expected {expected:.4} V, got {actual:.4} V"
        );
    }
}

#[test]
fn rl_step_response_follows_the_exponential() {
    let (r, l): (f64, f64) = (100.0, 10e-3);
    let tau = l / r;

    let mut c = Circuit::new();
    let vin = c.node("vin");
    let mid = c.node("mid");
    c.add(Box::new(VoltageSource::new("V1", vin, Circuit::GROUND, step(5.0))));
    c.add(Box::new(Resistor::new("R1", vin, mid, r)));
    c.add(Box::new(Inductor::new("L1", mid, Circuit::GROUND, l)));

    let mut cfg = TransientConfig::new(5.0 * tau);
    cfg.max_step = tau / 50.0;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();
    let il = index_of(&result, "i(L1)");

    // The inductor current rises as I_final * (1 - e^-t/tau), I_final = V/R.
    for k in [0.5f64, 1.0, 2.0] {
        let expected = (5.0 / r) * (1.0 - (-k).exp());
        let actual = value_at(&result, il, k * tau);
        assert!(
            (actual - expected).abs() < 0.02 * (5.0 / r),
            "at t = {k} tau expected {expected:.6} A, got {actual:.6} A"
        );
    }
}

#[test]
fn lc_tank_oscillates_at_its_resonant_frequency_without_losing_energy() {
    let (l, cap): (f64, f64) = (1e-3, 1e-6);
    let period = std::f64::consts::TAU * (l * cap).sqrt();

    let mut c = Circuit::new();
    let a = c.node("a");
    c.add(Box::new(Capacitor::new("C1", a, Circuit::GROUND, cap).with_ic(1.0)));
    c.add(Box::new(Inductor::new("L1", a, Circuit::GROUND, l)));

    let mut cfg = TransientConfig::new(4.0 * period);
    cfg.max_step = period / 200.0;
    cfg.use_initial_conditions = true;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let va = index_of(&result, "v(a)");
    let il = index_of(&result, "i(L1)");

    // Energy is conserved exactly in an ideal tank; the trapezoidal rule adds no
    // numerical damping, so any real loss here means a broken companion model.
    let energy = |t: f64| {
        let v = value_at(&result, va, t);
        let i = value_at(&result, il, t);
        0.5 * cap * v * v + 0.5 * l * i * i
    };
    let start = energy(period * 0.05);
    let end = energy(period * 3.9);
    assert!((end - start).abs() / start < 0.02, "energy drifted from {start:.6e} to {end:.6e}");

    // And it should still be at a peak one whole period later.
    let v0 = value_at(&result, va, 0.0);
    let v1 = value_at(&result, va, period);
    assert!((v1 - v0).abs() < 0.05, "after one period: {v0:.4} vs {v1:.4}");
}

// ---------------------------------------------------------------------------
// Analog: nonlinear
// ---------------------------------------------------------------------------

#[test]
fn diode_rectifies_a_sine() {
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::new(
        "V1",
        vin,
        Circuit::GROUND,
        Waveform::Sine {
            offset: 0.0,
            amplitude: 10.0,
            frequency: 1_000.0,
            delay: 0.0,
            damping: 0.0,
            phase: 0.0,
        },
    )));
    c.add(Box::new(Diode::new("D1", vin, out, DiodeModel::default())));
    c.add(Box::new(Resistor::new("R1", out, Circuit::GROUND, 1_000.0)));

    let mut cfg = TransientConfig::new(3e-3);
    cfg.max_step = 2e-6;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();
    let out = index_of(&result, "v(out)");
    let (lo, hi) = extremes(&result, out);

    // The positive half survives, minus a forward drop.
    assert!(hi > 9.0 && hi < 10.0, "peak was {hi:.3} V");
    // The negative half is blocked. Only leakage gets through.
    assert!(lo > -0.05, "reverse leak reached {lo:.5} V");
}

#[test]
fn zener_clamps_at_its_breakdown_voltage() {
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::dc("V1", vin, Circuit::GROUND, 12.0)));
    c.add(Box::new(Resistor::new("R1", vin, out, 1_000.0)));
    // Cathode at `out`, anode at ground: reverse biased, so it breaks down.
    c.add(Box::new(Diode::new("D1", Circuit::GROUND, out, DiodeModel::zener(5.1))));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let i = op.unknown_names.iter().position(|n| n == "v(out)").unwrap();
    let v = op.solution[i];
    // Tight, because `bv` is now the voltage at a milliamp rather than the foot
    // of the curve: a part declared as 5.1 V has to regulate near 5.1 V.
    assert!((5.0..=5.4).contains(&v), "zener settled at {v:.3} V");
}

#[test]
fn bjt_amplifies_in_the_active_region() {
    // Common emitter: 1 MΩ base bias, 1 kΩ collector load, 5 V rail.
    let mut c = Circuit::new();
    let vcc = c.node("vcc");
    let base = c.node("base");
    let col = c.node("col");
    c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 5.0)));
    c.add(Box::new(Resistor::new("RB", vcc, base, 1e6)));
    c.add(Box::new(Resistor::new("RC", vcc, col, 1_000.0)));
    c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, BjtModel::npn())));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let vb = op.solution[op.unknown_names.iter().position(|n| n == "v(base)").unwrap()];
    let vc = op.solution[op.unknown_names.iter().position(|n| n == "v(col)").unwrap()];

    // A forward-biased silicon base-emitter junction sits near 0.65 V.
    assert!((0.55..=0.80).contains(&vb), "vbe was {vb:.3} V");
    // Ib ~ 4.3 uA, Ic ~ beta * Ib ~ 0.87 mA, so the collector drops ~0.87 V.
    assert!((3.6..=4.6).contains(&vc), "collector sat at {vc:.3} V");
}

#[test]
fn nmos_inverter_switches_both_ways() {
    let run = |vgate: f64| {
        let mut c = Circuit::new();
        let vdd = c.node("vdd");
        let gate = c.node("gate");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("VDD", vdd, Circuit::GROUND, 5.0)));
        c.add(Box::new(VoltageSource::dc("VG", gate, Circuit::GROUND, vgate)));
        c.add(Box::new(Resistor::new("RD", vdd, out, 10_000.0)));
        c.add(Box::new(Mosfet::new("M1", out, gate, Circuit::GROUND, MosfetModel::nmos())));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()]
    };

    let high = run(0.0);
    let low = run(5.0);
    assert!(high > 4.9, "cut off, output should sit at the rail, got {high:.3} V");
    assert!(low < 1.2, "turned on, output should pull down, got {low:.3} V");
}

#[test]
fn pmos_conducts_with_a_low_gate() {
    let run = |vgate: f64| {
        let mut c = Circuit::new();
        let vdd = c.node("vdd");
        let gate = c.node("gate");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("VDD", vdd, Circuit::GROUND, 5.0)));
        c.add(Box::new(VoltageSource::dc("VG", gate, Circuit::GROUND, vgate)));
        // Source on the rail, drain on the output, pulled down by a load.
        c.add(Box::new(Mosfet::new("M1", out, gate, vdd, MosfetModel::pmos())));
        c.add(Box::new(Resistor::new("RL", out, Circuit::GROUND, 10_000.0)));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()]
    };

    assert!(run(0.0) > 3.8, "gate low should turn a PMOS on, got {:.3} V", run(0.0));
    assert!(run(5.0) < 0.5, "gate high should turn it off, got {:.3} V", run(5.0));
}

#[test]
fn inverting_opamp_has_the_designed_gain() {
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let inv = c.node("inv");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::dc("V1", vin, Circuit::GROUND, 0.1)));
    c.add(Box::new(Resistor::new("R1", vin, inv, 1_000.0)));
    c.add(Box::new(Resistor::new("RF", inv, out, 10_000.0)));
    c.add(Box::new(OpAmp::new("U1", out, Circuit::GROUND, inv).with_rails(-15.0, 15.0)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let names = &op.unknown_names;
    let vout = op.solution[names.iter().position(|n| n == "v(out)").unwrap()];
    let vinv = op.solution[names.iter().position(|n| n == "v(inv)").unwrap()];

    assert!((vout + 1.0).abs() < 0.01, "gain of -10 should give -1 V, got {vout:.4} V");
    // The inverting input is a virtual ground.
    assert!(vinv.abs() < 1e-3, "virtual ground drifted to {vinv:.6} V");
}

#[test]
fn opamp_comparator_saturates_at_the_rail() {
    let run = |vin: f64| {
        let mut c = Circuit::new();
        let a = c.node("a");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, vin)));
        c.add(Box::new(OpAmp::new("U1", out, a, Circuit::GROUND).with_rails(0.0, 5.0)));
        c.add(Box::new(Resistor::new("RL", out, Circuit::GROUND, 100_000.0)));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()]
    };

    assert!(run(1.0) > 4.99, "got {:.4}", run(1.0));
    assert!(run(-1.0) < 0.01, "got {:.4}", run(-1.0));
}

#[test]
fn dc_sweep_traces_a_diode_iv_curve() {
    let mut c = Circuit::new();
    let a = c.node("a");
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 0.0)));
    c.add(Box::new(Diode::new("D1", a, Circuit::GROUND, DiodeModel::default())));
    c.build();

    let values: Vec<f64> = (0..=14).map(|k| k as f64 * 0.05).collect();
    let mut sim = Simulator::default();
    let sweep = sim
        .dc_sweep(&mut c, &values, |circuit, v| {
            // Rewriting the source in place is what makes each point seed the next.
            let element = &mut circuit.elements_mut()[0];
            let source =
                element.as_any_mut().downcast_mut::<VoltageSource>().expect("element 0 is V1");
            source.waveform = Waveform::Dc { value: v };
        })
        .unwrap();

    let i_index = c.unknown_names().iter().position(|n| n == "i(V1)").unwrap();
    let currents: Vec<f64> = sweep.iter().map(|row| -row[i_index]).collect();

    // Monotonic, and roughly a decade of current per 60 mV once conducting.
    for pair in currents.windows(2) {
        assert!(pair[1] >= pair[0] - 1e-12, "current went backwards: {pair:?}");
    }
    assert!(currents[0].abs() < 1e-12, "no bias should mean no current");
    assert!(
        *currents.last().unwrap() > 1e-4,
        "0.7 V should conduct, got {:.3e}",
        currents.last().unwrap()
    );
}

// ---------------------------------------------------------------------------
// Frequency domain
// ---------------------------------------------------------------------------

/// Magnitude and phase of an unknown at the frequency nearest `hz`.
fn at_frequency(result: &AcResult, name: &str, hz: f64) -> (f64, f64) {
    let signal = result.index_of(name).unwrap_or_else(|| panic!("no unknown named {name}"));
    let mut best = 0;
    for (i, f) in result.frequencies.iter().enumerate() {
        if (f.ln() - hz.ln()).abs() < (result.frequencies[best].ln() - hz.ln()).abs() {
            best = i;
        }
    }
    (result.magnitude[signal][best], result.phase[signal][best])
}

#[test]
fn rc_low_pass_has_the_textbook_response() {
    let (r, cap) = (1_000.0, 1e-7);
    let cutoff = 1.0 / (std::f64::consts::TAU * r * cap);

    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(
        VoltageSource::new("V1", vin, Circuit::GROUND, Waveform::Dc { value: 0.0 })
            .with_ac(1.0, 0.0),
    ));
    c.add(Box::new(Resistor::new("R1", vin, out, r)));
    c.add(Box::new(Capacitor::new("C1", out, Circuit::GROUND, cap)));

    let result = Simulator::default()
        .ac_sweep(&mut c, AcConfig::new(cutoff / 1000.0, cutoff * 1000.0))
        .unwrap();

    // Passband: unity gain, no phase shift.
    let (low_mag, low_phase) = at_frequency(&result, "v(out)", cutoff / 1000.0);
    assert!((low_mag - 1.0).abs() < 1e-4, "passband gain was {low_mag}");
    assert!(low_phase.abs() < 0.2, "passband phase was {low_phase}");

    // At the corner: -3 dB and exactly -45 degrees. This is the single number
    // that says whether the complex stamping is right.
    let (corner_mag, corner_phase) = at_frequency(&result, "v(out)", cutoff);
    assert!(
        (corner_mag - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01,
        "corner gain was {corner_mag}, expected 0.7071"
    );
    assert!((corner_phase + 45.0).abs() < 1.0, "corner phase was {corner_phase}");

    // Stopband: a single pole rolls off at 20 dB per decade, and one decade past
    // the corner the gain is a tenth.
    let (decade_mag, _) = at_frequency(&result, "v(out)", cutoff * 10.0);
    assert!((decade_mag - 0.1).abs() < 0.005, "a decade out the gain was {decade_mag}");

    // And the phase keeps going to -90, rather than wrapping back to +180.
    let (_, far_phase) = at_frequency(&result, "v(out)", cutoff * 1000.0);
    assert!((far_phase + 90.0).abs() < 1.0, "asymptotic phase was {far_phase}");
}

#[test]
fn series_rlc_peaks_at_its_resonant_frequency() {
    let (l, cap, r): (f64, f64, f64) = (10e-3, 1e-6, 5.0);
    let resonance = 1.0 / (std::f64::consts::TAU * (l * cap).sqrt());

    let mut c = Circuit::new();
    let vin = c.node("vin");
    let mid = c.node("mid");
    let out = c.node("out");
    c.add(Box::new(
        VoltageSource::new("V1", vin, Circuit::GROUND, Waveform::Dc { value: 0.0 })
            .with_ac(1.0, 0.0),
    ));
    c.add(Box::new(Resistor::new("R1", vin, mid, r)));
    c.add(Box::new(Inductor::new("L1", mid, out, l)));
    c.add(Box::new(Capacitor::new("C1", out, Circuit::GROUND, cap)));

    let result = Simulator::default()
        .ac_sweep(&mut c, AcConfig::new(resonance / 100.0, resonance * 100.0))
        .unwrap();

    let index = result.index_of("v(out)").unwrap();
    let peak = result.magnitude[index]
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(i, v)| (result.frequencies[i], *v))
        .unwrap();

    // The peak lands at the resonant frequency, within the sweep's resolution.
    assert!(
        (peak.0 / resonance - 1.0).abs() < 0.15,
        "peak at {:.1} Hz, expected {resonance:.1} Hz",
        peak.0
    );
    // And it is a real peak: Q = (1/R)*sqrt(L/C) = 20 here, so the gain well
    // exceeds unity.
    let expected_q = (1.0 / r) * (l / cap).sqrt();
    assert!(peak.1 > expected_q * 0.7, "peak gain {} against Q {expected_q}", peak.1);
}

#[test]
fn inverting_opamp_gain_is_flat_and_inverted() {
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let inv = c.node("inv");
    let out = c.node("out");
    c.add(Box::new(
        VoltageSource::new("V1", vin, Circuit::GROUND, Waveform::Dc { value: 0.0 })
            .with_ac(1.0, 0.0),
    ));
    c.add(Box::new(Resistor::new("R1", vin, inv, 1_000.0)));
    c.add(Box::new(Resistor::new("RF", inv, out, 22_000.0)));
    c.add(Box::new(OpAmp::new("U1", out, Circuit::GROUND, inv).with_rails(-15.0, 15.0)));

    let result = Simulator::default().ac_sweep(&mut c, AcConfig::new(1.0, 1e5)).unwrap();

    for hz in [10.0, 1_000.0, 50_000.0] {
        let (mag, phase) = at_frequency(&result, "v(out)", hz);
        assert!((mag - 22.0).abs() < 0.1, "gain at {hz} Hz was {mag}, expected 22");
        // Inverting: 180 degrees out, whichever way the unwrapper walked to it.
        assert!((phase.abs() - 180.0).abs() < 1.0, "phase at {hz} Hz was {phase}, expected ±180");
    }
}

#[test]
fn ac_analysis_linearizes_around_the_operating_point() {
    // A common-emitter stage: the gain AC reports must come from the bias the DC
    // solution actually settled at, not from an idealisation.
    let build = |rb: f64| {
        let mut c = Circuit::new();
        let vcc = c.node("vcc");
        let base = c.node("base");
        let col = c.node("col");
        let input = c.node("in");
        c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 12.0)));
        c.add(Box::new(Resistor::new("RB", vcc, base, rb)));
        c.add(Box::new(Resistor::new("RC", vcc, col, 2_200.0)));
        c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, BjtModel::npn())));
        c.add(Box::new(
            VoltageSource::new("V2", input, Circuit::GROUND, Waveform::Dc { value: 0.0 })
                .with_ac(1.0, 0.0),
        ));
        c.add(Box::new(Capacitor::new("CIN", input, base, 10e-6)));
        c
    };

    let mut biased = build(470_000.0);
    let result =
        Simulator::default().ac_sweep(&mut biased, AcConfig::new(100.0, 100_000.0)).unwrap();
    let (gain, phase) = at_frequency(&result, "v(col)", 10_000.0);

    // gm = Ic/Vt with Ic near 5 mA gives a gain of roughly gm * Rc — hundreds,
    // and inverted.
    assert!(gain > 50.0, "expected real voltage gain, got {gain}");
    assert!((phase.abs() - 180.0).abs() < 25.0, "a common emitter inverts; phase was {phase}");

    // Starve the base and the transistor falls out of conduction, so the gain
    // has to collapse. An analysis that ignored the operating point would report
    // the same number as before.
    let mut starved = build(1e9);
    let off = Simulator::default().ac_sweep(&mut starved, AcConfig::new(100.0, 100_000.0)).unwrap();
    let (off_gain, _) = at_frequency(&off, "v(col)", 10_000.0);
    assert!(off_gain < gain / 100.0, "cut off, the gain was still {off_gain}");
}

// ---------------------------------------------------------------------------
// Digital
// ---------------------------------------------------------------------------

#[test]
fn flip_flop_divides_the_clock_by_two() {
    let mut c = Circuit::new();
    let clk = c.net("clk");
    let q = c.net("q");
    let qn = c.net("qn");
    c.add_device(Box::new(Clock::new("CLK", clk, 1e6, 0.5)));
    // Feeding qn back into d makes it toggle on every rising edge.
    c.add_device(Box::new(DFlipFlop::new("FF", clk, qn, None, q, qn, 1e-9)));

    let mut cfg = TransientConfig::new(10e-6);
    cfg.max_step = 100e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let clk_index = result.net_names.iter().position(|n| n == "clk").unwrap();
    let q_index = result.net_names.iter().position(|n| n == "q").unwrap();

    // Index 0 of each trace is the starting value, not a transition.
    let transitions = |net: usize| result.digital[net].iter().filter(|(t, _)| *t > 0.0).count();
    let clk_edges = transitions(clk_index);
    let q_edges = transitions(q_index);

    // 10 us at 1 MHz is 10 cycles, so 20 clock transitions and half as many on q.
    assert!((19..=21).contains(&clk_edges), "clock produced {clk_edges} transitions");
    assert!(
        (q_edges as f64 - clk_edges as f64 / 2.0).abs() <= 2.0,
        "q produced {q_edges} transitions against {clk_edges} on the clock"
    );
}

#[test]
fn nand_gate_truth_table_holds_over_time() {
    let mut c = Circuit::new();
    // Two clocks at different rates walk the inputs through all four combinations.
    let a = c.net("a");
    let b = c.net("b");
    let y = c.net("y");
    c.add_device(Box::new(Clock::new("CA", a, 1e6, 0.5)));
    c.add_device(Box::new(Clock::new("CB", b, 5e5, 0.5)));
    c.add_device(Box::new(Gate::new("U1", GateKind::Nand, vec![a, b], y, 1e-9)));

    let mut cfg = TransientConfig::new(8e-6);
    cfg.max_step = 50e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let idx = |name: &str| result.net_names.iter().position(|n| n == name).unwrap();
    let level_at = |net: usize, t: f64| {
        result.digital[net]
            .iter()
            .rev()
            .find(|(when, _)| *when <= t)
            .map(|(_, s)| *s)
            .unwrap_or(Logic::Unknown)
    };

    let (a, b, y) = (idx("a"), idx("b"), idx("y"));
    let mut saw_both = (false, false);
    // Offset off the clock edges so we never sample a signal mid-flight: edges
    // land on multiples of 500 ns and the gate delay is 1 ns.
    for k in 1..78 {
        let t = 50e-9 + k as f64 * 100e-9;
        let (va, vb, vy) = (level_at(a, t), level_at(b, t), level_at(y, t));
        let expected = va.and(vb).invert();
        assert_eq!(vy, expected, "at t = {t:.2e}: {va:?} nand {vb:?}");
        match vy {
            Logic::High => saw_both.0 = true,
            Logic::Low => saw_both.1 = true,
            _ => {}
        }
    }
    assert!(saw_both.0 && saw_both.1, "the output never exercised both levels");
}

// ---------------------------------------------------------------------------
// Mixed signal
// ---------------------------------------------------------------------------

#[test]
fn analog_input_drives_digital_logic_and_comes_back_out() {
    let family = LogicFamily::cmos_5v();

    let mut c = Circuit::new();
    let ain = c.node("ain");
    let dout = c.node("dout");

    // A slow sine that clearly crosses both logic thresholds.
    c.add(Box::new(VoltageSource::new(
        "V1",
        ain,
        Circuit::GROUND,
        Waveform::Sine {
            offset: 2.5,
            amplitude: 2.4,
            frequency: 10_000.0,
            delay: 0.0,
            damping: 0.0,
            phase: 0.0,
        },
    )));
    c.add(Box::new(Resistor::new("RL", dout, Circuit::GROUND, 10_000.0)));

    let d_in = c.net("d_in");
    let d_out = c.net("d_out");
    c.bridge_to_digital("A1", ain, d_in, family);
    c.add_device(Box::new(Gate::new("U1", GateKind::Not, vec![d_in], d_out, 10e-9)));
    c.bridge_to_analog("B1", d_out, dout, family);

    let mut cfg = TransientConfig::new(300e-6);
    cfg.max_step = 500e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let ain_i = index_of(&result, "v(ain)");
    let dout_i = index_of(&result, "v(dout)");
    let (lo, hi) = extremes(&result, dout_i);

    // The digital output actually swings rail to rail on the analog side.
    assert!(lo < 0.3, "digital low reached only {lo:.3} V");
    assert!(hi > 4.6, "digital high reached only {hi:.3} V");

    // And it is genuinely inverted: whenever the input is unambiguously high,
    // the output must be low. Sampling is offset past the gate delay.
    let mut checked = 0;
    for (k, t) in result.time.iter().enumerate() {
        if *t < 40e-6 {
            continue;
        }
        let v_in = result.solution[k][ain_i];
        if v_in > 4.6 {
            let v_out = result.solution[k][dout_i];
            assert!(v_out < 1.0, "input {v_in:.2} V but output {v_out:.2} V at t = {t:.3e}");
            checked += 1;
        }
    }
    assert!(checked > 10, "only {checked} samples were unambiguously high");
}

#[test]
fn digital_output_charges_an_rc_through_its_output_impedance() {
    let family = LogicFamily::cmos_5v();
    let mut c = Circuit::new();
    let out = c.node("out");
    // 10 kΩ and 100 pF against a 50 Ω driver: the RC dominates.
    c.add(Box::new(Resistor::new("R1", out, Circuit::GROUND, 10_000.0)));
    c.add(Box::new(Capacitor::new("C1", out, Circuit::GROUND, 100e-12)));

    let clk = c.net("clk");
    c.add_device(Box::new(Clock::new("CLK", clk, 100e3, 0.5)));
    c.bridge_to_analog("B1", clk, out, family);

    let mut cfg = TransientConfig::new(30e-6);
    cfg.max_step = 50e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let out_i = index_of(&result, "v(out)");
    let (lo, hi) = extremes(&result, out_i);

    // The 50 Ω driver against a 10 kΩ pulldown loses about half a percent.
    assert!(hi > 4.9 && hi <= 5.01, "high level was {hi:.4} V");
    assert!(lo < 0.05, "low level was {lo:.4} V");

    // Nothing may exceed the rails: an overshooting companion model would show
    // up right here.
    assert!(lo >= -0.1, "undershot to {lo:.4} V");
}

#[test]
fn a_floating_node_does_not_make_the_solver_give_up() {
    let mut c = Circuit::new();
    let a = c.node("a");
    let orphan = c.node("orphan");
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 5.0)));
    c.add(Box::new(Resistor::new("R1", a, Circuit::GROUND, 1_000.0)));
    // `orphan` is connected to exactly one thing and nothing else. Users draw
    // this constantly; gmin is what keeps the matrix invertible.
    c.add(Box::new(Capacitor::new("C1", orphan, a, 1e-9)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    assert!(op.solution.iter().all(|v| v.is_finite()));
}

#[test]
fn a_shorted_voltage_source_is_reported_rather_than_panicking() {
    let mut c = Circuit::new();
    let a = c.node("a");
    // Two ideal sources at different voltages across the same pair of nodes has
    // no solution, and the engine must say so instead of producing nonsense.
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 5.0)));
    c.add(Box::new(VoltageSource::dc("V2", a, Circuit::GROUND, 3.0)));

    let err = Simulator::default().operating_point(&mut c).unwrap_err();
    assert!(matches!(err, SimError::Singular { .. } | SimError::NoConvergence { .. }), "got {err}");
}

// ---------------------------------------------------------------------------
// Parts that fail
// ---------------------------------------------------------------------------

/// A supply, a series resistor and an LED, wired in a loop.
///
/// The resistor is what sets the current, so it is the one knob these tests
/// turn: a large one keeps the part inside its rating, a small one destroys it.
fn led_circuit(series: f64, rated: f64) -> Circuit {
    let mut c = Circuit::new();
    let rail = c.node("rail");
    let anode = c.node("anode");
    c.add(Box::new(VoltageSource::dc("V1", rail, Circuit::GROUND, 5.0)));
    c.add(Box::new(Resistor::new("R1", rail, anode, series)));
    c.add(Box::new(Diode::new("D1", anode, Circuit::GROUND, DiodeModel::led(1.9, rated))));
    c
}

#[test]
fn an_led_run_inside_its_rating_survives() {
    // 330 ohms from 5 V through a 1.9 V part is about 9 mA, comfortably under
    // the 20 mA it is specified for. Nothing may happen to it, however long the
    // run: a part that fails while being used correctly is worse than useless.
    let mut c = led_circuit(330.0, 0.02);
    let result = Simulator::default().transient(&mut c, TransientConfig::new(0.5)).unwrap();

    assert!(result.failures.is_empty(), "failed with {:?}", result.failures);
    let current = result.current_signal(result.element_index("D1").unwrap());
    let last = *current.last().unwrap();
    assert!((last - 0.0094).abs() < 5e-4, "settled at {last:.5} A");
}

#[test]
fn an_led_driven_far_past_its_rating_burns_out() {
    // 33 ohms instead of 330 — the decimal point in the wrong place, and the
    // most common way anyone destroys one of these.
    let mut c = led_circuit(33.0, 0.02);
    let result = Simulator::default().transient(&mut c, TransientConfig::new(2e-3)).unwrap();

    assert_eq!(result.failures.len(), 1);
    let failure = &result.failures[0];
    assert_eq!(failure.name, "D1");
    assert!(failure.peak > 0.07, "peaked at {:.4} A", failure.peak);

    // At about four times rated, the dose rule puts the failure near a third of
    // a millisecond in.
    assert!((failure.time - 3.2e-4).abs() < 5e-5, "failed at {:.2} us", failure.time * 1e6);
}

#[test]
fn a_burnt_out_led_stops_conducting_for_the_rest_of_the_run() {
    // The whole point of modelling the failure inside the transient loop rather
    // than reading it off the answer afterwards: what happens next is the
    // circuit with the part gone, not the circuit as if it had survived.
    let mut c = led_circuit(33.0, 0.02);
    let result = Simulator::default().transient(&mut c, TransientConfig::new(2e-3)).unwrap();
    let failed_at = result.failures[0].time;

    let current = result.element_index("D1").unwrap();
    let anode = index_of(&result, "v(anode)");

    let before = value_at(&result, anode, failed_at * 0.5);
    assert!((before - 2.2).abs() < 0.4, "anode sat at {before:.3} V while lit");

    for (i, &t) in result.time.iter().enumerate() {
        if t <= failed_at {
            continue;
        }
        let i_d = result.currents[i][current];
        assert!(i_d.abs() < 1e-6, "still carrying {i_d:.3e} A at {t:.3e} s");
    }

    // With nothing drawing current there is no drop across the series resistor,
    // so the anode is pulled all the way to the rail.
    let after = value_at(&result, anode, 1.5e-3);
    assert!((after - 5.0).abs() < 1e-3, "anode sat at {after:.4} V after the failure");
}

#[test]
fn a_brief_pulse_over_the_rating_does_not_destroy_anything() {
    // Ten times rated for a few microseconds is how a multiplexed display runs.
    // An instantaneous threshold would have condemned this part.
    let mut c = Circuit::new();
    let rail = c.node("rail");
    let anode = c.node("anode");
    c.add(Box::new(VoltageSource::new(
        "V1",
        rail,
        Circuit::GROUND,
        Waveform::Pulse {
            v1: 0.0,
            v2: 8.0,
            delay: 1e-4,
            rise: 1e-7,
            fall: 1e-7,
            width: 5e-6,
            period: 1.0,
        },
    )));
    c.add(Box::new(Resistor::new("R1", rail, anode, 30.0)));
    c.add(Box::new(Diode::new("D1", anode, Circuit::GROUND, DiodeModel::led(1.9, 0.02))));

    let result = Simulator::default().transient(&mut c, TransientConfig::new(1e-3)).unwrap();
    let peak = result
        .current_signal(result.element_index("D1").unwrap())
        .into_iter()
        .fold(0.0f64, f64::max);

    assert!(peak > 0.1, "the pulse only reached {peak:.4} A, so this proves nothing");
    assert!(result.failures.is_empty(), "destroyed by a pulse: {:?}", result.failures);
}

#[test]
fn a_diode_with_no_rating_is_indestructible() {
    // An ordinary rectifier carries no rating, and must not acquire one by
    // accident: silently opening a diode mid-run would be a spectacular way to
    // produce a wrong answer.
    let mut c = led_circuit(1.0, 0.02);
    if let Some(d) = c.elements_mut()[2].as_any_mut().downcast_mut::<Diode>() {
        d.model.rated = None;
    }

    let result = Simulator::default().transient(&mut c, TransientConfig::new(2e-3)).unwrap();
    assert!(result.failures.is_empty());
}

#[test]
fn re_running_gives_the_part_its_life_back() {
    // State from a previous run must not leak into the next one, or a circuit
    // that was fixed would go on failing until the page was reloaded.
    let mut c = led_circuit(33.0, 0.02);
    let mut sim = Simulator::default();
    let first = sim.transient(&mut c, TransientConfig::new(2e-3)).unwrap();
    assert_eq!(first.failures.len(), 1);

    if let Some(d) = c.elements_mut()[1].as_any_mut().downcast_mut::<Resistor>() {
        d.r = 330.0;
    }
    let second = sim.transient(&mut c, TransientConfig::new(2e-3)).unwrap();
    assert!(second.failures.is_empty(), "still failing: {:?}", second.failures);
}
