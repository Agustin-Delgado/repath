//! End-to-end checks against circuits whose answers are known independently —
//! from closed-form analysis, from the device equations, or from what the part
//! is supposed to do. These are the tests that would catch a sign error in a
//! stamp, which the unit tests cannot.

use repath_core::digital::Logic;
use repath_core::elements::semiconductor::TNOM;
use repath_core::netlist::{Component, Netlist};
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
    let solve = |vin: f64| {
        let mut c = Circuit::new();
        let input = c.node("vin");
        let inv = c.node("inv");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("V1", input, Circuit::GROUND, vin)));
        c.add(Box::new(Resistor::new("R1", input, inv, 1_000.0)));
        c.add(Box::new(Resistor::new("RF", inv, out, 10_000.0)));
        c.add(Box::new(OpAmp::new("U1", out, Circuit::GROUND, inv).with_rails(-15.0, 15.0)));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        let names = &op.unknown_names;
        (
            op.solution[names.iter().position(|n| n == "v(out)").unwrap()],
            op.solution[names.iter().position(|n| n == "v(inv)").unwrap()],
        )
    };

    // Measured across two inputs rather than from one, which is how you would
    // measure it on a bench and for the same reason: a real part has an input
    // offset, and reading a single point cannot tell the gain from the error.
    // Eleven times a millivolt of offset is eleven millivolts on the output here —
    // one percent of the answer, and nothing whatever to do with the gain.
    let (hi, vinv) = solve(0.1);
    let (lo, _) = solve(-0.1);
    let gain = (hi - lo) / 0.2;
    assert!((gain + 10.0).abs() < 0.02, "expected a gain of -10, got {gain:.4}");

    // The inverting input is a virtual ground — give or take the offset the loop
    // is holding it at.
    assert!(vinv.abs() < 5e-3, "virtual ground drifted to {vinv:.6} V");
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
fn an_inverting_stage_spends_its_gain_bandwidth_product() {
    // Gain and bandwidth are one quantity divided two ways. A part good for a
    // megahertz asked for a gain of 22 has 45 kHz to give, and no amount of
    // feedback buys any of it back — which is the single most useful thing to
    // know about an op-amp and the thing an ideal one cannot tell you.
    let build = |gbw: f64| {
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
        let model = OpAmpModel { gbw, ..OpAmpModel::default() };
        c.add(Box::new(OpAmp::new("U1", out, Circuit::GROUND, inv).with_model(model)));
        c
    };

    let mut c = build(1e6);
    let result = Simulator::default().ac_sweep(&mut c, AcConfig::new(1.0, 1e7)).unwrap();

    // Low down, the loop has gain to spare and the resistors decide everything.
    for hz in [10.0, 100.0] {
        let (mag, phase) = at_frequency(&result, "v(out)", hz);
        assert!((mag - 22.0).abs() < 0.1, "gain at {hz} Hz was {mag}, expected 22");
        assert!((phase.abs() - 180.0).abs() < 1.0, "phase at {hz} Hz was {phase}");
    }

    // At the corner it is down by root two, and the phase has begun to go with it.
    let (corner, phase) = at_frequency(&result, "v(out)", 1e6 / 22.0);
    assert!(
        (corner - 22.0 / std::f64::consts::SQRT_2).abs() < 1.0,
        "at the corner the gain was {corner}, expected about 15.6"
    );
    assert!((phase.abs() - 180.0).abs() > 30.0, "phase should have moved by now: {phase}");

    // Well past it the product is the constant: gain times frequency is the
    // gain-bandwidth, whatever the closed loop was asked for.
    let (top, _) = at_frequency(&result, "v(out)", 1e6);
    assert!(top < 1.5, "gain at the unity-gain frequency was {top}, expected about 1");

    // And it moves with the part. Ten times the product is ten times the corner.
    let mut fast = build(1e7);
    let quick = Simulator::default().ac_sweep(&mut fast, AcConfig::new(1.0, 1e7)).unwrap();
    let (still_flat, _) = at_frequency(&quick, "v(out)", 1e6 / 22.0);
    assert!(
        (still_flat - 22.0).abs() < 0.5,
        "a decade more bandwidth should still be flat here, got {still_flat}"
    );
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

/// An RC charged through a switch, in the JSON the editor emits for one: the
/// contact is a voltage-controlled switch and the actuator is a PWL source on a
/// node of its own. `CONTACT` is where the control goes; everything else is the
/// circuit around it.
fn switched_rc(contact: &str) -> String {
    format!(
        r#"{{"components":[
{{"type":"voltage_source","name":"V1","plus":"in","minus":"gnd","waveform":{{"type":"dc","value":5}}}},
{{"type":"voltage_source","name":"S1__actuator","plus":"S1__contact","minus":"gnd","waveform":{{"type":"pwl","points":[{contact}]}}}},
{{"type":"switch","name":"S1","a":"in","b":"mid","control_plus":"S1__contact","control_minus":"gnd","model":{{"v_on":1,"v_off":0,"r_on":0.05,"r_off":1e9}}}},
{{"type":"resistor","name":"R1","a":"mid","b":"out","resistance":1000}},
{{"type":"resistor","name":"R2","a":"out","b":"gnd","resistance":100000}},
{{"type":"capacitor","name":"C1","a":"out","b":"gnd","capacitance":1e-6}}],
"devices":[],"bridges":[]}}"#
    )
}

fn run_switched(contact: &str) -> TransientResult {
    let netlist: Netlist =
        serde_json::from_str(&switched_rc(contact)).expect("the editor's netlist should parse");
    let mut c = netlist.compile().expect("and should compile");
    Simulator::default().transient(&mut c, TransientConfig::new(8e-3)).unwrap()
}

#[test]
fn a_switch_closes_when_it_is_told_to() {
    // Open, the contact is 1 GΩ and the load sits at a millivolt of leakage;
    // closed, it is an ordinary RC with a millisecond time constant. The whole
    // part is which of those two the circuit is at any moment.
    //
    // The load resistor is not decoration. Without it the capacitor has no path
    // to ground at DC, so the operating point charges it to the supply through
    // the open contact and the switch appears to do nothing — which is exactly
    // what a real circuit does, and why a floating node is worth avoiding.
    let result = run_switched("[0,0],[0.000999,0],[0.001,1]");
    let out = index_of(&result, "v(out)");

    assert!(value_at(&result, out, 0.9e-3).abs() < 1e-3, "the open contact leaked");
    // One time constant after it closes. 1 kΩ against a 100 kΩ load makes that
    // 990 µs, and the rail it is heading for 4.95 V.
    let one_tau = value_at(&result, out, 2e-3);
    assert!(
        (one_tau - 3.147).abs() < 0.06,
        "expected 3.15 V one tau after closing, got {one_tau:.3}"
    );
    assert!(value_at(&result, out, 6e-3) > 4.85, "it never finished charging");
}

#[test]
fn contact_bounce_holds_the_charge_back() {
    // A real contact chatters for a millisecond before it settles, and a
    // millisecond is a whole time constant here: the capacitor is charged in
    // pieces and arrives late. This is the difference a debounce circuit exists
    // to remove, and simulating a switch that lands cleanly hides it entirely.
    let clean = run_switched("[0,0],[0.000999,0],[0.001,1]");
    let bouncing = run_switched(
        "[0,0],[0.000999,0],[0.001,1],[0.0014,1],[0.0015,0],[0.0017,0],[0.0018,1],[0.0019,1],[0.002,0],[0.0021,0],[0.0022,1]",
    );

    let a = value_at(&clean, index_of(&clean, "v(out)"), 2.2e-3);
    let b = value_at(&bouncing, index_of(&bouncing, "v(out)"), 2.2e-3);
    assert!(
        b < a - 0.4,
        "bouncing reached {b:.3} V against {a:.3} V clean; the chatter did nothing"
    );
    // And it still gets there, once the contact settles.
    assert!(value_at(&bouncing, index_of(&bouncing, "v(out)"), 7e-3) > 4.85);
}

/// Three clocks and a three-input NAND, in the JSON the editor emits for a gate
/// whose input count was turned up. Written the way the compiler writes it
/// rather than through the builder, because the thing being tested is the
/// contract between the two.
const WIDE_NAND: &str = r#"{"components":[],"bridges":[],"devices":[
{"type":"clock","name":"CLK1","output":"a","frequency":1000000,"duty":0.5},
{"type":"clock","name":"CLK2","output":"b","frequency":500000,"duty":0.5},
{"type":"clock","name":"CLK3","output":"c","frequency":250000,"duty":0.5},
{"type":"gate","name":"U1","kind":"nand","inputs":["a","b","c"],"output":"y","delay":1e-9},
{"type":"gate","name":"U2","kind":"xnor","inputs":["a","b"],"output":"z","delay":1e-9}]}"#;

#[test]
fn a_three_input_gate_decides_in_one_delay_rather_than_two() {
    // The reason input count is a property of the gate and not something you
    // build out of two-input parts: a chain of two costs two propagation delays,
    // and at any clock rate worth simulating that difference is the answer.
    let netlist: Netlist =
        serde_json::from_str(WIDE_NAND).expect("the editor's netlist should parse");
    let mut c = netlist.compile().expect("and should compile");

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

    let (a, b, cc, y, z) = (idx("a"), idx("b"), idx("c"), idx("y"), idx("z"));
    let mut seen = (false, false);
    for k in 1..78 {
        // Off the clock edges, which land on multiples of 500 ns.
        let t = 50e-9 + k as f64 * 100e-9;
        let (va, vb, vc) = (level_at(a, t), level_at(b, t), level_at(cc, t));
        assert_eq!(
            level_at(y, t),
            va.and(vb).and(vc).invert(),
            "at t = {t:.2e}: nand({va:?}, {vb:?}, {vc:?})"
        );
        assert_eq!(level_at(z, t), va.xor(vb).invert(), "at t = {t:.2e}: xnor({va:?}, {vb:?})");
        match level_at(y, t) {
            Logic::High => seen.0 = true,
            Logic::Low => seen.1 = true,
            _ => {}
        }
    }
    assert!(seen.0 && seen.1, "the three-input output never exercised both levels");

    // And it is one delay, not two. Every transition on the output has to land a
    // nanosecond after an input moved — a chain of two-input gates would put the
    // slow ones two nanoseconds out and this would not notice the difference in
    // the truth table alone.
    let edges: Vec<f64> =
        [a, b, cc].iter().flat_map(|n| result.digital[*n].iter().map(|(t, _)| *t)).collect();
    for (t, _) in result.digital[y].iter().filter(|(t, _)| *t > 0.0) {
        let closest = edges.iter().map(|e| (t - e).abs()).fold(f64::INFINITY, f64::min);
        assert!(
            (closest - 1e-9).abs() < 1e-12,
            "an output edge at {t:.4e} sat {closest:.2e} after its cause"
        );
    }
}

/// Two tri-state buffers sharing one wire, which is the only reason the part
/// exists. `ea` and `eb` are driven by clocks that are never both high.
const SHARED_BUS: &str = r#"{"components":[],"bridges":[],"devices":[
{"type":"clock","name":"CLK1","output":"ea","frequency":250000,"duty":0.5},
{"type":"gate","name":"U3","kind":"not","inputs":["ea"],"output":"eb","delay":1e-9},
{"type":"clock","name":"CLK2","output":"da","frequency":1000000,"duty":0.5},
{"type":"gate","name":"U4","kind":"not","inputs":["da"],"output":"db","delay":1e-9},
{"type":"tri_state","name":"U1","input":"da","enable":"ea","output":"bus","delay":1e-9},
{"type":"tri_state","name":"U2","input":"db","enable":"eb","output":"bus","delay":1e-9}]}"#;

#[test]
fn two_tri_states_take_turns_on_one_wire() {
    let netlist: Netlist =
        serde_json::from_str(SHARED_BUS).expect("the editor's netlist should parse");
    let mut c = netlist.compile().expect("and should compile");

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

    let (ea, da, db, bus) = (idx("ea"), idx("da"), idx("db"), idx("bus"));
    let mut drove = (false, false);
    for k in 1..78 {
        let t = 50e-9 + k as f64 * 100e-9;
        // Whichever half of the cycle it is, exactly one buffer is enabled, so the
        // wire carries that one's input and the other contributes nothing at all.
        let enabled = level_at(ea, t);
        let expected = if enabled == Logic::High { level_at(da, t) } else { level_at(db, t) };
        assert_eq!(level_at(bus, t), expected, "at t = {t:.2e} with ea {enabled:?}");
        if enabled == Logic::High { drove.0 = true } else { drove.1 = true }
    }
    assert!(drove.0 && drove.1, "only one of the two buffers ever had the wire");
}

// ---------------------------------------------------------------------------
// Mixed signal
// ---------------------------------------------------------------------------

#[test]
fn a_digital_edge_lands_where_the_threshold_was_crossed() {
    // A ramp whose crossing is exact arithmetic rather than a simulation result:
    // 0 to 5 V over a millisecond meets a 3.5 V threshold at 700 µs, and no
    // choice of timestep changes that. Stepped deliberately coarsely, so the
    // crossing falls well inside a step and there is somewhere wrong to land.
    //
    // The bridge interpolates it, and the transient loop used to round that back
    // up to the end of the step — which is every edge quantized to the analog
    // grid, and every propagation delay downstream measured from the wrong
    // instant.
    let mut c = Circuit::new();
    let n = c.node("in");
    c.add(Box::new(VoltageSource::new(
        "V1",
        n,
        Circuit::GROUND,
        Waveform::Pwl { points: vec![(0.0, 0.0), (1e-3, 5.0)] },
    )));
    c.add(Box::new(Resistor::new("R1", n, Circuit::GROUND, 1e6)));
    let net = c.net("d");
    c.bridge_to_digital("A1", n, net, LogicFamily::cmos_5v());

    let mut cfg = TransientConfig::new(1e-3);
    cfg.max_step = 1e-4; // ten steps across the whole ramp
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let rise = result.digital[0]
        .iter()
        .find(|(_, state)| *state == Logic::High)
        .map(|(t, _)| *t)
        .expect("the ramp crosses v_ih, so there has to be a rising edge");

    // Within a nanosecond of the arithmetic answer, on steps a hundred
    // microseconds long.
    assert!(
        (rise - 700e-6).abs() < 1e-9,
        "edge at {rise:.6e} s, threshold crossed at 7.000000e-4 s"
    );
    // And no sample sits there, so this cannot be passing by landing on one.
    assert!(
        !result.time.iter().any(|t| (t - 700e-6).abs() < 1e-9),
        "the run happened to solve a timepoint at the crossing; the test proves nothing"
    );
}

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

#[test]
fn collector_current_climbs_with_vce_by_the_early_voltage() {
    // Base-width modulation, measured the way a curve tracer would: hold the base
    // current and sweep the collector. Without it the two readings are identical
    // and the output conductance is exactly zero, which is what made every gain
    // into a high impedance come out unbounded.
    let collector_current_at = |vce: f64| {
        let mut c = Circuit::new();
        let b = c.node("b");
        let col = c.node("c");
        c.add(Box::new(CurrentSource::new(
            "IB",
            Circuit::GROUND,
            b,
            Waveform::Dc { value: 10e-6 },
        )));
        c.add(Box::new(VoltageSource::dc("VC", col, Circuit::GROUND, vce)));
        c.add(Box::new(Bjt::new("Q1", col, b, Circuit::GROUND, BjtModel::npn())));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        let i = op.unknown_names.iter().position(|n| n == "i(VC)").unwrap();
        // Out of the source's positive terminal and into the collector.
        -op.solution[i]
    };

    let low = collector_current_at(2.0);
    let high = collector_current_at(10.0);
    assert!(high > low, "collector current did not climb: {low:.6} then {high:.6}");

    // Early voltage of 100 V: eight more volts across the device should add about
    // 8/102 of the current it was already passing.
    let expected = low * 8.0 / 102.0;
    let climb = high - low;
    assert!(
        (climb - expected).abs() < 0.25 * expected,
        "climbed by {climb:.3e} A, expected about {expected:.3e} A"
    );

    // And the slope is the output conductance, which is what a stage's gain is
    // eventually limited by. Ten microamps of base at a gain of 200 is 2 mA of
    // collector, so `ro = (VAF + Vce) / Ic` is about 51 kilohms.
    let ro = 8.0 / climb;
    assert!((40_000.0..65_000.0).contains(&ro), "output resistance came to {ro:.0} ohms");
}

#[test]
fn a_conducting_diode_does_not_switch_off_the_instant_it_is_reversed() {
    // Reverse recovery. A junction that has been passing current is full of
    // carriers, and they have to be swept out before it blocks — so for a moment
    // after the drive reverses the diode conducts *backwards*, hard. Without any
    // stored charge it simply stops, which is why a rectifier used to look
    // perfect at any frequency at all.
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::new(
        "V1",
        vin,
        Circuit::GROUND,
        Waveform::Pulse {
            v1: 5.0,
            v2: -5.0,
            delay: 1e-6,
            rise: 1e-9,
            fall: 1e-9,
            width: 1e-6,
            period: 1e9,
        },
    )));
    c.add(Box::new(Resistor::new("R1", vin, out, 100.0)));
    // A transit time an order up from the default, so the effect is unmistakable
    // rather than a numerical whisker.
    let model = DiodeModel { tt: 50e-9, ..DiodeModel::default() };
    c.add(Box::new(Diode::new("D1", out, Circuit::GROUND, model)));

    let mut cfg = TransientConfig::new(3e-6);
    cfg.max_step = 2e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();

    let d1 = result.element_index("D1").unwrap();
    let current = result.current_signal(d1);
    let forward = *current.iter().max_by(|a, b| a.total_cmp(b)).unwrap();
    let backward = *current.iter().min_by(|a, b| a.total_cmp(b)).unwrap();

    assert!(forward > 0.03, "never conducted forwards: peak {forward:.4} A");
    // The reverse spike is the stored charge leaving. It is large — the resistor
    // is all that limits it — and brief.
    assert!(backward < -0.01, "no reverse recovery at all: {backward:.6} A");

    // And it is over quickly. Late in the reverse window the charge is gone and
    // the diode is blocking properly — recovery is a moment, not a state.
    let late = result
        .time
        .iter()
        .position(|&t| t >= 1.9e-6)
        .expect("the run should reach the end of the reverse window");
    let recovered = current[late];
    assert!(recovered.abs() < 1e-6, "still passing {recovered:.3e} A once recovered");
}

#[test]
fn a_transistor_stage_runs_out_of_gain_at_the_top() {
    // Every amplifier has a top end, and a model without junction capacitances
    // does not: the gain it reports at ten megahertz is the gain it reports at ten
    // kilohertz, which is the one answer that is certainly wrong.
    //
    // The dominant term is not the capacitance itself but what the stage does to
    // it. `cjc` bridges the base to the collector, so the source charging it has
    // to swing it by the input *and* the inverted output — Miller — and a few
    // picofarads across a gain of four hundred is a nanofarad at the input.
    let build = |model: BjtModel| {
        let mut c = Circuit::new();
        let vcc = c.node("vcc");
        let base = c.node("base");
        let col = c.node("col");
        let input = c.node("in");
        let driven = c.node("driven");
        c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 12.0)));
        c.add(Box::new(Resistor::new("RB", vcc, base, 470_000.0)));
        c.add(Box::new(Resistor::new("RC", vcc, col, 2_200.0)));
        c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, model)));
        c.add(Box::new(
            VoltageSource::new("V2", driven, Circuit::GROUND, Waveform::Dc { value: 0.0 })
                .with_ac(1.0, 0.0),
        ));
        // A source that is not ideal. With a stiff drive there is nothing for the
        // input capacitance to work against and the corner runs off the top of any
        // sweep — which is true of the real circuit too.
        c.add(Box::new(Resistor::new("RS", driven, input, 10_000.0)));
        c.add(Box::new(Capacitor::new("CIN", input, base, 10e-6)));
        c
    };

    let sweep = |model: BjtModel| {
        let mut c = build(model);
        let result = Simulator::default().ac_sweep(&mut c, AcConfig::new(1_000.0, 100e6)).unwrap();
        let (mid, _) = at_frequency(&result, "v(col)", 10_000.0);
        let (top, _) = at_frequency(&result, "v(col)", 10e6);
        (mid, top)
    };

    let (mid, top) = sweep(BjtModel::npn());
    assert!(mid > 20.0, "no midband gain to lose: {mid:.1}");
    assert!(top < mid / 20.0, "gain at 10 MHz was {top:.1} against {mid:.1} at 10 kHz");

    // And it is the capacitances doing it. Strip them and the same stage keeps its
    // gain to the top of the sweep, which is how this looked before they existed.
    let ideal = BjtModel { cje: 0.0, cjc: 0.0, tf: 0.0, tr: 0.0, ..BjtModel::npn() };
    let (flat_mid, flat_top) = sweep(ideal);
    assert!(
        flat_top > flat_mid / 1.1,
        "with no charge storage the response should be flat: {flat_mid:.1} then {flat_top:.1}"
    );
}

#[test]
fn an_npn_and_a_pnp_take_the_same_time_to_switch() {
    // The two polarities are one set of equations mirrored, so the stored charge
    // has to mirror with everything else. It is the easiest thing in the file to
    // get half-wrong: the capacitance is the same either way round, but the
    // history current the companion model injects is not, and a missing sign there
    // leaves the NPN perfect and the PNP driving its own charge the wrong way.
    let switch_time = |pnp: bool| {
        let sign = if pnp { -1.0 } else { 1.0 };
        let mut c = Circuit::new();
        let rail = c.node("rail");
        let drive = c.node("drive");
        let base = c.node("base");
        let col = c.node("col");
        c.add(Box::new(VoltageSource::dc("V1", rail, Circuit::GROUND, 5.0 * sign)));
        c.add(Box::new(VoltageSource::new(
            "VG",
            drive,
            Circuit::GROUND,
            Waveform::Pulse {
                v1: 0.0,
                v2: 3.0 * sign,
                delay: 1e-7,
                rise: 1e-12,
                fall: 1e-12,
                width: 1e9,
                period: 0.0,
            },
        )));
        c.add(Box::new(Resistor::new("RB", drive, base, 10_000.0)));
        c.add(Box::new(Resistor::new("RC", rail, col, 1_000.0)));
        let model = if pnp { BjtModel::pnp() } else { BjtModel::npn() };
        c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, model)));

        let mut cfg = TransientConfig::new(4e-6);
        cfg.max_step = 2e-9;
        let result = Simulator::default().transient(&mut c, cfg).unwrap();
        let col_index = index_of(&result, "v(col)");
        let signal = result.signal(col_index);

        // When the collector has come three quarters of the way to ground.
        let crossed =
            signal.iter().position(|&v| v * sign < 1.25).expect("the transistor never turned on");
        result.time[crossed] - 1e-7
    };

    let npn = switch_time(false);
    let pnp = switch_time(true);
    assert!(npn > 5e-9, "switched in {npn:.3e} s, which is no time at all");
    assert!(
        (npn - pnp).abs() < 0.05 * npn,
        "npn took {npn:.4e} s and pnp took {pnp:.4e} s; they are the same circuit mirrored"
    );
}

#[test]
fn a_mosfet_gate_has_to_be_charged_before_the_drain_moves() {
    // A gate is a capacitor with a channel underneath it. Nothing about the drain
    // current says so — it is a function of the gate *voltage* — so with no gate
    // capacitance a MOSFET switches the instant the drive does, no matter what is
    // driving it. That is what makes a gate-drive resistor look free.
    let drain_at = |cgs: f64, cgd: f64, t: f64| {
        let mut c = Circuit::new();
        let vdd = c.node("vdd");
        let drive = c.node("drive");
        let gate = c.node("gate");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("VDD", vdd, Circuit::GROUND, 5.0)));
        c.add(Box::new(VoltageSource::new("VG", drive, Circuit::GROUND, step(5.0))));
        c.add(Box::new(Resistor::new("RG", drive, gate, 100_000.0)));
        c.add(Box::new(Resistor::new("RD", vdd, out, 2_000.0)));
        let model = MosfetModel { cgs, cgd, cds: 5e-12, ..MosfetModel::nmos() };
        c.add(Box::new(Mosfet::new("M1", out, gate, Circuit::GROUND, model)));

        let mut cfg = TransientConfig::new(2e-5);
        cfg.max_step = 1e-8;
        let result = Simulator::default().transient(&mut c, cfg).unwrap();
        value_at(&result, index_of(&result, "v(out)"), t)
    };

    // 100 k into 25 pF is a couple of microseconds, and the Miller term on `cgd`
    // stretches the middle of the transition well past that.
    let early = drain_at(20e-12, 5e-12, 2e-7);
    let settled = drain_at(20e-12, 5e-12, 1.5e-5);
    assert!(early > 4.8, "the drain had already moved to {early:.3} V at 200 ns");
    assert!(settled < 3.6, "the drain never switched: {settled:.3} V");

    // Without the gate capacitance the same drive switches it immediately.
    let instant = drain_at(0.0, 0.0, 2e-7);
    assert!(
        (instant - settled).abs() < 0.05,
        "with no gate charge it should already be at {settled:.3} V, got {instant:.3} V"
    );
}

#[test]
fn a_common_emitter_stage_has_the_input_resistance_its_gain_implies() {
    // rπ = β / gm, and nothing else should be loading the base. This is worth
    // pinning because it is invisible from a DC measurement: the base current was
    // right, the collector current was right, the ratio between them was 200 — and
    // the small-signal input resistance was still five times too low, because the
    // Early term had leaked into the base-collector conductance where Miller then
    // multiplied it by the gain. Every gain figure taken from a source with any
    // impedance at all was wrong by that factor.
    let mut c = Circuit::new();
    let vcc = c.node("vcc");
    let base = c.node("base");
    let col = c.node("col");
    let driven = c.node("driven");
    let input = c.node("in");
    c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 12.0)));
    c.add(Box::new(Resistor::new("RB", vcc, base, 470_000.0)));
    c.add(Box::new(Resistor::new("RC", vcc, col, 2_200.0)));
    c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, BjtModel::npn())));
    c.add(Box::new(
        VoltageSource::new("V2", driven, Circuit::GROUND, Waveform::Dc { value: 0.0 })
            .with_ac(1.0, 0.0),
    ));
    let source = 1_000.0;
    c.add(Box::new(Resistor::new("RS", driven, input, source)));
    c.add(Box::new(Capacitor::new("CIN", input, base, 10e-6)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let vcol = op.solution[op.unknown_names.iter().position(|n| n == "v(col)").unwrap()];
    let ic = (12.0 - vcol) / 2_200.0;
    // rπ = β·Vt/Ic, with Vt about 25.9 mV at the default temperature.
    let expected = 200.0 * (repath_core::elements::thermal_voltage(300.15)) / ic;

    // Well below the stage's corner, so the divider is resistive.
    let result = Simulator::default().ac_sweep(&mut c, AcConfig::new(500.0, 2_000.0)).unwrap();
    let (at_base, _) = at_frequency(&result, "v(base)", 1_000.0);
    let measured = source * at_base / (1.0 - at_base);

    assert!(
        (measured - expected).abs() < 0.05 * expected,
        "input resistance came to {measured:.0} ohms; beta over gm says {expected:.0}"
    );
}

#[test]
fn a_mosfet_drain_cannot_be_dragged_below_its_source() {
    // Drawing a MOSFET with three terminals ties the bulk to the source, and that
    // puts a junction across drain and source that nobody chose. It is why you
    // cannot pull the drain of an n-channel device below its source: the body
    // diode conducts and clamps it a drop down, and every freewheeling path in
    // every half-bridge ever built is that diode.
    //
    // It was invisible until the terminal capacitances arrived, because nothing
    // could push the drain there. Now a fast gate edge can, through `cgd`, and
    // without the diode the drain of an unloaded inverter left the rails entirely.
    let mut c = Circuit::new();
    let pull = c.node("pull");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::dc("V1", pull, Circuit::GROUND, -5.0)));
    c.add(Box::new(Resistor::new("R1", out, pull, 1_000.0)));
    // Gate at ground: the channel is firmly off, so anything here is the diode.
    c.add(Box::new(Mosfet::new("M1", out, Circuit::GROUND, Circuit::GROUND, MosfetModel::nmos())));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let v = op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()];
    assert!((-1.0..-0.3).contains(&v), "the drain settled at {v:.3} V; it should clamp near -0.7");

    // And the part has to admit it is carrying the clamp current. Reporting the
    // channel alone would draw a device sitting at a diode drop, passing milliamps,
    // with nothing moving through it.
    let result = Simulator::default().transient(&mut c, TransientConfig::new(1e-5)).unwrap();
    let m1 = result.element_index("M1").expect("a mosfet should report a current");
    let i = result.current_signal(m1)[result.time.len() - 1];
    assert!(i < -3e-3, "the body diode was passing {i:.4} A, expected about -4 mA");
}

// ---------------------------------------------------------------------------
// The contract with the editor
// ---------------------------------------------------------------------------

/// Model JSON exactly as the editor emits it for a part with a `.model` card
/// pasted onto it — copied from what the compiler actually produced, not from
/// what it was expected to produce.
const CARD_2N3904: &str = r#"{"polarity":"npn","is":6.734e-15,"bf":416.4,"br":0.7371,
"vaf":74.03,"cjc":3.638e-12,"tf":3.012e-10,"temp":300.15,"cje":4.493e-12,"vje":0.75,
"mje":0.2593,"vjc":0.75,"mjc":0.3085,"tr":2.395e-7}"#;

const CARD_1N4148: &str =
    r#"{"is":2.52e-9,"n":1.752,"bv":100,"temp":300.15,"cj0":4e-12,"m":0.4,"tt":2e-8}"#;

#[test]
fn a_model_card_from_the_editor_arrives_intact() {
    // Pasting a manufacturer's card is only worth anything if the numbers survive
    // the trip. Two sides have to agree on every name for that — the editor maps
    // SPICE spellings onto these fields, and a mismatch would be silent: serde
    // fills a missing field with its default, so the part would simulate as a
    // perfectly ordinary transistor and nothing anywhere would say otherwise.
    let q: BjtModel = serde_json::from_str(CARD_2N3904).expect("the editor's JSON should parse");
    assert!((q.bf - 416.4).abs() < 1e-9, "bf came through as {}", q.bf);
    assert_eq!(q.vaf, Some(74.03));
    assert!((q.br - 0.7371).abs() < 1e-9);
    assert!((q.cje - 4.493e-12).abs() < 1e-24);
    assert!((q.mje - 0.2593).abs() < 1e-9);
    assert!((q.tr - 239.5e-9).abs() < 1e-18);
    // Not in the card, so the default stands rather than being zeroed.
    assert!(q.tf > 0.0);

    let d: DiodeModel = serde_json::from_str(CARD_1N4148).expect("the editor's JSON should parse");
    assert!((d.is - 2.52e-9).abs() < 1e-18);
    assert!((d.n - 1.752).abs() < 1e-9);
    assert_eq!(d.bv, Some(100.0));
    assert!((d.cj0 - 4e-12).abs() < 1e-24);
    assert!((d.tt - 20e-9).abs() < 1e-18);
}

#[test]
fn a_pasted_part_behaves_like_the_part_it_names() {
    // And the numbers have to reach the solve, not just the struct. A 2N3904 has
    // twice the gain of the generic transistor this editor ships, so the same
    // stage biased the same way has to pass about twice the collector current.
    let collector_current = |model: BjtModel| {
        let mut c = Circuit::new();
        let vcc = c.node("vcc");
        let base = c.node("base");
        let col = c.node("col");
        c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 12.0)));
        // Fed from a current source, so the base drive is the same in both runs
        // and the collector current is the gain and nothing else.
        c.add(Box::new(CurrentSource::new(
            "IB",
            Circuit::GROUND,
            base,
            Waveform::Dc { value: 10e-6 },
        )));
        c.add(Box::new(Resistor::new("RC", vcc, col, 100.0)));
        c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, model)));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        let v = op.solution[op.unknown_names.iter().position(|n| n == "v(col)").unwrap()];
        (12.0 - v) / 100.0
    };

    let generic = collector_current(BjtModel::npn());
    let real = collector_current(serde_json::from_str(CARD_2N3904).unwrap());
    let ratio = real / generic;
    assert!(
        (1.9..2.3).contains(&ratio),
        "a beta of 416 against 200 should roughly double the current; got {generic:.4} then \
         {real:.4}, a ratio of {ratio:.2}"
    );
}

/// An inverting amplifier whose op-amp is an imported `.subckt`, exactly as the
/// editor flattens it — copied from what the compiler produced, not written out
/// by hand. `X1.` names are the block's insides; the rest is the drawing.
const IMPORTED_OPAMP_AMP: &str = r#"{"components":[
{"type":"voltage_source","name":"V1","plus":"in","minus":"gnd","waveform":{"type":"dc","value":0},"ac_magnitude":1,"ac_phase":0},
{"type":"resistor","name":"RIN","a":"in","b":"inv","resistance":1000},
{"type":"resistor","name":"RF","a":"inv","b":"out","resistance":10000},
{"type":"resistor","name":"X1.RIN","a":"gnd","b":"inv","resistance":2000000},
{"type":"vcvs","name":"X1.E1","plus":"X1.4","minus":"gnd","control_plus":"gnd","control_minus":"inv","gain":100000},
{"type":"resistor","name":"X1.R1","a":"X1.4","b":"X1.5","resistance":1000},
{"type":"capacitor","name":"X1.C1","a":"X1.5","b":"gnd","capacitance":0.0000159},
{"type":"vcvs","name":"X1.E2","plus":"X1.6","minus":"gnd","control_plus":"X1.5","control_minus":"gnd","gain":1},
{"type":"resistor","name":"X1.ROUT","a":"X1.6","b":"out","resistance":75}],
"devices":[],"bridges":[]}"#;

#[test]
fn a_subcircuit_pasted_from_a_file_amplifies() {
    // The whole of step three in one check: a `.subckt` read from a vendor's
    // file, flattened into element lines, its ports bound to the nets it was
    // dropped on and its internal nodes kept to itself — and then the thing
    // behaves like the part it claims to be.
    //
    // Ten kilohms over one is a gain of ten, inverted, and that number comes from
    // the resistors around the block rather than from anything inside it. Getting
    // it right means the ports went to the right nets: swap the two inputs and
    // the feedback stops being negative.
    let netlist: Netlist =
        serde_json::from_str(IMPORTED_OPAMP_AMP).expect("the editor's netlist should parse");
    let mut c = netlist.compile().expect("and should compile");

    let result = Simulator::default().ac_sweep(&mut c, AcConfig::new(10.0, 1_000.0)).unwrap();
    let (gain, phase) = at_frequency(&result, "v(out)", 100.0);
    assert!((gain - 10.0).abs() < 0.2, "expected a gain of ten, got {gain:.3}");
    assert!((phase.abs() - 180.0).abs() < 5.0, "an inverting stage; phase was {phase:.1}");

    // And the pole inside the block is real, which is the point of importing a
    // macromodel rather than using an ideal op-amp: 100 000 falling from 10 Hz is
    // a gain-bandwidth product of a megahertz, so a closed loop asking for ten of
    // it runs out at a hundred kilohertz and has to follow the open loop down.
    let wide = Simulator::default().ac_sweep(&mut c, AcConfig::new(10.0, 10e6)).unwrap();
    let (corner, _) = at_frequency(&wide, "v(out)", 100e3);
    let (past, _) = at_frequency(&wide, "v(out)", 2e6);
    assert!((6.0..8.5).contains(&corner), "expected the corner near 100 kHz; gain was {corner:.3}");
    assert!(past < 1.0, "the internal pole did nothing: gain at 2 MHz was {past:.3}");
}

#[test]
fn a_follower_cannot_move_faster_than_its_slew_rate() {
    // The most visible thing an ideal op-amp gets wrong. Told to jump ten volts,
    // a real one ramps, because the input stage can only deliver so much current
    // into the compensation capacitor. Half a volt per microsecond means sixteen
    // microseconds to cross the middle eight volts of that jump, and no feedback
    // makes it any quicker: while it is slewing the amplifier has no gain at all.
    let mut c = Circuit::new();
    let vin = c.node("vin");
    let out = c.node("out");
    c.add(Box::new(VoltageSource::new("V1", vin, Circuit::GROUND, step(10.0))));
    // Unity-gain follower: output straight back to the inverting input.
    c.add(Box::new(OpAmp::new("U1", out, vin, out)));

    let mut cfg = TransientConfig::new(60e-6);
    cfg.max_step = 20e-9;
    let result = Simulator::default().transient(&mut c, cfg).unwrap();
    let index = index_of(&result, "v(out)");
    let signal = result.signal(index);

    let crossing =
        |level: f64| result.time[signal.iter().position(|&v| v >= level).expect("never got there")];
    let ramp = crossing(9.0) - crossing(1.0);
    let expected = 8.0 / 0.5e6;
    assert!(
        (ramp - expected).abs() < 0.15 * expected,
        "crossed the middle eight volts in {ramp:.3e} s; half a volt per microsecond says {expected:.3e}"
    );

    // And it gets there in the end, rather than ramping forever.
    let (_, high) = extremes(&result, index);
    assert!((high - 10.0).abs() < 0.05, "settled at {high:.4} V");
}

#[test]
fn an_amplifier_amplifies_its_own_offset_too() {
    // Both inputs at zero and the output is not: the input pair is never quite
    // matched, and whatever mismatch it has comes out multiplied by the gain the
    // circuit was built for. It is why a high-gain DC amplifier needs trimming,
    // and with an ideal op-amp there is nothing there to trim.
    let gain_of = |v_os: f64| {
        let mut c = Circuit::new();
        let inv = c.node("inv");
        let out = c.node("out");
        // Non-inverting, gain of 101, input grounded.
        c.add(Box::new(Resistor::new("RG", inv, Circuit::GROUND, 100.0)));
        c.add(Box::new(Resistor::new("RF", inv, out, 10_000.0)));
        let model = OpAmpModel { v_os, i_bias: 0.0, ..OpAmpModel::default() };
        c.add(Box::new(OpAmp::new("U1", out, Circuit::GROUND, inv).with_model(model)));

        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()]
    };

    let with = gain_of(1e-3);
    assert!(
        (with - 0.101).abs() < 0.002,
        "a millivolt of offset times 101 is 101 mV; got {with:.4}"
    );

    // A perfectly matched part sits where an ideal one always did, so the offset
    // is the only thing being measured here.
    assert!(gain_of(0.0).abs() < 1e-6, "with no offset it should sit at zero");
}

#[test]
fn an_op_amp_drives_a_load_through_its_output_resistance() {
    // Open loop and hard against a rail, so nothing is correcting for it: what
    // reaches the load is a divider between the part's output resistance and
    // whatever is hanging off it. Closing a loop hides this at low frequencies
    // and stops hiding it as the loop gain falls, which is the honest reason an
    // op-amp's output impedance is on its datasheet.
    let reached = |load: f64| {
        let mut c = Circuit::new();
        let plus = c.node("plus");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("V1", plus, Circuit::GROUND, 1.0)));
        c.add(Box::new(Resistor::new("RL", out, Circuit::GROUND, load)));
        c.add(Box::new(OpAmp::new("U1", out, plus, Circuit::GROUND)));
        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()]
    };

    // A volt in, open loop: the gain node is pinned at the positive rail.
    let light = reached(1e6);
    assert!((light - 15.0).abs() < 0.05, "unloaded it should reach the rail, got {light:.3}");

    // 75 ohms out into 75 ohms of load is half of it.
    let heavy = reached(75.0);
    assert!((heavy - 7.5).abs() < 0.2, "into an equal load, expected about half; got {heavy:.3}");
}

#[test]
fn a_diode_stops_being_an_exponential_at_high_current() {
    // The bulk resistance does nothing at a milliamp and is most of the forward
    // drop at an amp. Without it the exponential runs off on its own: a volt
    // across a small-signal diode came out at nine amps, and past that the solve
    // gave up entirely, because nothing in the model says the silicon between the
    // junction and the leads has any resistance at all.
    let current_at = |v: f64, rs: f64| {
        let mut c = Circuit::new();
        let a = c.node("a");
        c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, v)));
        c.add(Box::new(Diode::new(
            "D1",
            a,
            Circuit::GROUND,
            DiodeModel { rs, ..Default::default() },
        )));
        let op = Simulator::default().operating_point(&mut c).ok()?;
        Some(-op.solution[op.unknown_names.iter().position(|n| n == "i(V1)").unwrap()])
    };

    // Low down, the resistance is beneath notice: a few millivolts of a drop that
    // is most of a volt.
    let (small, ideal) = (current_at(0.6, 0.568).unwrap(), current_at(0.6, 0.0).unwrap());
    assert!((small - ideal).abs() < 0.05 * ideal, "{small:.6} A against {ideal:.6} A");

    // High up it is the whole story. Above the knee the drop is the junction plus
    // `rs·i`, so the current climbs about linearly rather than by a decade every
    // hundred millivolts.
    let one = current_at(1.0, 0.568).unwrap();
    let two = current_at(2.0, 0.568).unwrap();
    assert!(one > 0.2 && one < 0.4, "a volt should give a few hundred mA, got {one:.4} A");
    let slope = (two - one) / 1.0;
    assert!(
        (slope - 1.0 / 0.568).abs() < 0.25 / 0.568,
        "past the knee it should climb at 1/rs; got {slope:.3} S against {:.3}",
        1.0 / 0.568
    );

    // And it is what lets the solve get there at all.
    assert!(current_at(5.0, 0.568).is_some(), "a diode across five volts should still solve");

    // A part that arrives without one is the runaway above, so the default is
    // part of the model rather than a number the caller has to know to supply.
    assert!(DiodeModel::default().rs > 0.0, "a diode should come with a bulk resistance");
}

#[test]
fn a_zener_in_hard_breakdown_stays_a_real_number() {
    // Breakdown is an exponential and needs the same damping conduction gets.
    // Without it a single overshooting iterate lands where `exp` is clamped —
    // flat, while still reporting the slope it had on the way up — and the solve
    // walks in and cannot walk back out.
    let mut c = Circuit::new();
    let rail = c.node("rail");
    let out = c.node("out");
    // Far past breakdown, and stiffly driven, which is the case that used to
    // leave the part looking like a short.
    c.add(Box::new(VoltageSource::dc("V1", rail, Circuit::GROUND, 30.0)));
    c.add(Box::new(Resistor::new("R1", rail, out, 100.0)));
    c.add(Box::new(Diode::new("D1", Circuit::GROUND, out, DiodeModel::zener(5.1))));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let v = op.solution[op.unknown_names.iter().position(|n| n == "v(out)").unwrap()];
    // A quarter of an amp through a 5.1 V part pushes it up a few hundred
    // millivolts, and the bulk resistance is what decides how far.
    assert!((5.0..6.5).contains(&v), "regulated at {v:.4} V");
}

#[test]
fn a_diode_drops_two_millivolts_less_for_every_degree_warmer() {
    // The number everybody knows, and the reason a bandgap reference has to work
    // for a living. It falls out of the saturation current, not out of a fudge:
    // hot, more carriers get over the gap, so less voltage passes the same
    // current. At a fixed current the drop should slide by about -2 mV/K.
    let drop_at = |kelvin: f64| {
        let netlist = Netlist {
            temperature: kelvin,
            components: vec![
                Component::CurrentSource {
                    name: "I1".into(),
                    plus: "gnd".into(),
                    minus: "a".into(),
                    waveform: Waveform::Dc { value: 1e-3 },
                    ac_magnitude: 0.0,
                    ac_phase: 0.0,
                },
                Component::Diode {
                    name: "D1".into(),
                    anode: "a".into(),
                    cathode: "gnd".into(),
                    model: DiodeModel::default(),
                },
            ],
            ..Default::default()
        };
        let mut c = netlist.compile().unwrap();
        let op = Simulator::default().operating_point(&mut c).unwrap();
        op.solution[op.unknown_names.iter().position(|n| n == "v(a)").unwrap()]
    };

    let cold = drop_at(273.15);
    let hot = drop_at(373.15);
    let slope = (hot - cold) / 100.0;
    assert!(
        (slope + 2.0e-3).abs() < 0.4e-3,
        "the drop moved by {:.3} mV/K, expected about -2",
        slope * 1000.0
    );

    // And reverse leakage runs the other way, roughly doubling every ten degrees.
    // Same expression, read at the other end of the curve.
    let leak_at = |kelvin: f64| {
        let netlist = Netlist {
            temperature: kelvin,
            components: vec![
                Component::VoltageSource {
                    name: "V1".into(),
                    plus: "a".into(),
                    minus: "gnd".into(),
                    waveform: Waveform::Dc { value: -5.0 },
                    ac_magnitude: 0.0,
                    ac_phase: 0.0,
                },
                Component::Diode {
                    name: "D1".into(),
                    anode: "a".into(),
                    cathode: "gnd".into(),
                    model: DiodeModel::default(),
                },
            ],
            ..Default::default()
        };
        let mut c = netlist.compile().unwrap();
        let op = Simulator::default().operating_point(&mut c).unwrap();
        -op.solution[op.unknown_names.iter().position(|n| n == "i(V1)").unwrap()]
    };
    let ratio = leak_at(TNOM + 10.0).abs() / leak_at(TNOM).abs();
    assert!((1.7..3.0).contains(&ratio), "ten degrees multiplied the leakage by {ratio:.2}");
}

#[test]
fn a_resistor_drifts_by_its_temperature_coefficient() {
    // A part with none is one made of a material that does not exist. Two hundred
    // parts per million per degree is ordinary metal film; over eighty degrees
    // that is a sixty-fourth of the value, which is more than the tolerance band
    // most people design against.
    let mut c = Circuit::new();
    let a = c.node("a");
    let mid = c.node("mid");
    c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 10.0)));
    // One drifting, one not: a divider made of a matched pair would not move at
    // all, which is exactly why precision dividers are built that way.
    let mut top = Resistor::new("R1", a, mid, 1000.0).with_tempco(200e-6, 0.0);
    top.temp = TNOM + 80.0;
    c.add(Box::new(top));
    c.add(Box::new(Resistor::new("R2", mid, Circuit::GROUND, 1000.0)));

    let op = Simulator::default().operating_point(&mut c).unwrap();
    let v = op.solution[op.unknown_names.iter().position(|n| n == "v(mid)").unwrap()];
    // R1 is up by 1.6%, so the divider leans away from it.
    let expected = 10.0 * 1000.0 / (1000.0 * 1.016 + 1000.0);
    assert!((v - expected).abs() < 5e-3, "divider sat at {v:.4} V, expected {expected:.4}");
}

/// The logic toggle: a level somebody set, in the JSON the editor emits for it.
///
/// Its whole reason to exist is that it needs no analog side. A switch feeding a
/// gate has to come from a rail through a contact, which is analog, so the gate
/// input is an analog node — and an analog node with no path to anywhere has no
/// voltage, which is what makes the pull-down resistor necessary. This never
/// leaves the digital domain: no components, no bridges, nothing to pull.
fn toggled_and(a: &str, b: &str) -> String {
    format!(
        r#"{{"components":[],"bridges":[],"devices":[
{{"type":"logic_source","name":"T1","output":"da","state":"{a}"}},
{{"type":"logic_source","name":"T2","output":"db","state":"{b}"}},
{{"type":"gate","name":"U1","kind":"and","inputs":["da","db"],"output":"dy","delay":1e-9}}]}}"#
    )
}

#[test]
fn a_logic_source_holds_the_level_it_was_set_to() {
    for (a, b, expected) in [
        ("low", "low", Logic::Low),
        ("high", "low", Logic::Low),
        ("low", "high", Logic::Low),
        ("high", "high", Logic::High),
    ] {
        let netlist: Netlist =
            serde_json::from_str(&toggled_and(a, b)).expect("the editor's netlist should parse");
        let mut c = netlist.compile().expect("and should compile");
        let result = Simulator::default().transient(&mut c, TransientConfig::new(1e-6)).unwrap();

        let dy = result.net_names.iter().position(|n| n == "dy").unwrap();
        // Sampled well past the gate delay, and again at the end: a source that
        // only drove at t = 0 would let the net drift back to unknown, and one
        // that re-triggered itself the way a clock does would still be moving.
        for t in [100e-9, 1e-6] {
            let level = result.digital[dy]
                .iter()
                .rev()
                .find(|(when, _)| *when <= t)
                .map(|(_, s)| *s)
                .unwrap_or(Logic::Unknown);
            assert_eq!(level, expected, "{a} and {b} at t = {t:.2e}");
        }

        // And it settled once rather than every timestep.
        let da = result.net_names.iter().position(|n| n == "da").unwrap();
        assert_eq!(result.digital[da].len(), 1, "the source kept re-driving its net");
    }
}

/// Operating one partway through a run puts the edge partway through the run.
///
/// The point of the whole `flips` mechanism: a click while something is playing
/// is an event at that instant, not a different initial condition. Written the
/// other way, the replay would come out flat at the level it ended on and the
/// step — the one thing somebody clicked to watch — would never be on screen.
#[test]
fn a_logic_source_can_be_operated_partway_through_the_run() {
    let netlist: Netlist = serde_json::from_str(
        r#"{"components":[],"bridges":[],"devices":[
{"type":"logic_source","name":"T1","output":"da","state":"low","flips":[300e-9]},
{"type":"logic_source","name":"T2","output":"db","state":"high"},
{"type":"gate","name":"U1","kind":"and","inputs":["da","db"],"output":"dy","delay":1e-9}]}"#,
    )
    .expect("the editor's netlist should parse");
    let mut c = netlist.compile().expect("and should compile");
    let result = Simulator::default().transient(&mut c, TransientConfig::new(1e-6)).unwrap();

    let dy = result.net_names.iter().position(|n| n == "dy").unwrap();
    let level_at = |t: f64| {
        result.digital[dy]
            .iter()
            .rev()
            .find(|(when, _)| *when <= t)
            .map(|(_, s)| *s)
            .unwrap_or(Logic::Unknown)
    };
    assert_eq!(level_at(100e-9), Logic::Low, "before the flip");
    assert_eq!(level_at(500e-9), Logic::High, "after it");

    // And the output really has an edge in it, rather than one long level.
    let edges = result.digital[dy].len();
    assert!(edges >= 2, "the output settled {edges} time(s); the flip left no step");
}

// ---------------------------------------------------------------------------
// Running a circuit rather than replaying one
// ---------------------------------------------------------------------------

/// An RC charging, solved in one go and again in twenty pieces.
///
/// The pieces do not land on the same timepoints — each call ends on its own
/// boundary — so this compares the answer, not the grid. If a run picked up
/// halfway had lost so much as the capacitor's charge, the two curves would
/// separate immediately.
#[test]
fn a_run_advanced_in_pieces_matches_the_same_run_solved_at_once() {
    let build = || {
        let mut c = Circuit::new();
        let a = c.node("a");
        let out = c.node("out");
        c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 5.0)));
        c.add(Box::new(Resistor::new("R1", a, out, 1000.0)));
        c.add(Box::new(Capacitor::new("C1", out, Circuit::GROUND, 1e-6)));
        c
    };

    let cfg = TransientConfig::new(5e-3);
    let mut whole = build();
    let batch = Simulator::default().transient(&mut whole, cfg).unwrap();

    let mut piecewise = build();
    let mut sim = Simulator::default();
    let (mut run, mut result) = sim.begin_transient(&mut piecewise, cfg).unwrap();
    for k in 1..=20 {
        result.append(
            sim.advance_transient(&mut piecewise, &mut run, cfg.stop * k as f64 / 20.0).unwrap(),
        );
    }

    let index = batch.index_of("v(out)").unwrap();
    for step in 0..=10 {
        let t = cfg.stop * step as f64 / 10.0;
        let (one, many) = (value_at(&batch, index, t), value_at(&result, index, t));
        assert!((one - many).abs() < 1e-6, "at t = {t:.2e}: {one:.9} vs {many:.9}");
    }
    assert!((run.time() - cfg.stop).abs() < 1e-9, "the run stopped at {}", run.time());
}

/// Throwing a switch partway through changes the future and leaves the past.
///
/// This is the whole point of a live run. Written the other way — as a property
/// of the circuit, re-solved from zero — the lamp would have been on since the
/// beginning, and the edge somebody threw the switch to see would not exist.
#[test]
fn a_switch_thrown_mid_run_leaves_everything_before_it_alone() {
    let mut c = Circuit::new();
    let supply = c.node("supply");
    let lamp = c.node("lamp");
    let control = c.node("ctl");
    c.add(Box::new(VoltageSource::dc("V1", supply, Circuit::GROUND, 5.0)));
    // The actuator: a source of its own, which is what gets rewritten.
    c.add(Box::new(VoltageSource::dc("S1__actuator", control, Circuit::GROUND, 0.0)));
    c.add(Box::new(Switch::new(
        "S1",
        supply,
        lamp,
        control,
        Circuit::GROUND,
        SwitchModel { v_on: 1.0, v_off: 0.0, r_on: 0.05, r_off: 1e12 },
    )));
    c.add(Box::new(Resistor::new("R1", lamp, Circuit::GROUND, 1000.0)));

    let cfg = TransientConfig::new(4e-3);
    let mut sim = Simulator::default();
    let (mut run, mut result) = sim.begin_transient(&mut c, cfg).unwrap();
    result.append(sim.advance_transient(&mut c, &mut run, 2e-3).unwrap());

    // Half past, and the lamp is dark. Now somebody closes the contact.
    let index = result.index_of("v(lamp)").unwrap();
    assert!(value_at(&result, index, 1e-3) < 0.01, "the lamp was lit before anybody touched it");
    assert!(c.set_source_waveform("S1__actuator", Waveform::Dc { value: 1.0 }));

    result.append(sim.advance_transient(&mut c, &mut run, 4e-3).unwrap());

    // The past is untouched and the future is lit.
    assert!(value_at(&result, index, 1e-3) < 0.01, "closing the switch rewrote the past");
    assert!(value_at(&result, index, 3e-3) > 4.9, "the lamp never came on");
}

/// The same, for the digital half.
#[test]
fn a_logic_source_can_be_operated_while_the_run_is_going() {
    let netlist: Netlist = serde_json::from_str(
        r#"{"components":[],"bridges":[],"devices":[
{"type":"logic_source","name":"T1","output":"da","state":"low"},
{"type":"logic_source","name":"T2","output":"db","state":"high"},
{"type":"gate","name":"U1","kind":"and","inputs":["da","db"],"output":"dy","delay":1e-9}]}"#,
    )
    .unwrap();
    let mut c = netlist.compile().unwrap();

    let cfg = TransientConfig::new(1e-6);
    let mut sim = Simulator::default();
    let (mut run, mut result) = sim.begin_transient(&mut c, cfg).unwrap();
    result.append(sim.advance_transient(&mut c, &mut run, 400e-9).unwrap());
    assert!(c.operate_logic("T1", Logic::High, run.time()));
    result.append(sim.advance_transient(&mut c, &mut run, 1e-6).unwrap());

    let dy = result.net_names.iter().position(|n| n == "dy").unwrap();
    let level_at = |t: f64| {
        result.digital[dy]
            .iter()
            .rev()
            .find(|(when, _)| *when <= t)
            .map(|(_, s)| *s)
            .unwrap_or(Logic::Unknown)
    };
    assert_eq!(level_at(200e-9), Logic::Low, "before the click");
    assert_eq!(level_at(800e-9), Logic::High, "after it");
    // One edge, recorded once — not one per chunk.
    assert_eq!(result.digital[dy].iter().filter(|(_, s)| *s == Logic::High).count(), 1);
}

/// A transistor reports the current the solver actually gave it.
///
/// The device's own answer and the resistor's have to be the same number: they
/// are the same amperes. They were not — the stamp carried the Early factor and
/// the temperature-corrected gain, and the figures handed to a probe carried
/// neither, so the scope drew a collector current a few percent under the one the
/// node voltages beside it had been solved for. Neither number looked wrong on
/// its own, which is why this went unnoticed.
#[test]
fn a_transistor_reports_the_current_the_circuit_was_solved_for() {
    /// Collector current, as the device says it and as the load resistor says it.
    fn measured(celsius: f64) -> (f64, f64) {
        let mut c = Circuit::new();
        let vcc = c.node("vcc");
        let col = c.node("col");
        let base = c.node("base");

        c.add(Box::new(VoltageSource::dc("V1", vcc, Circuit::GROUND, 10.0)));
        c.add(Box::new(Resistor::new("RC", vcc, col, 1000.0)));
        c.add(Box::new(Resistor::new("RB", vcc, base, 470_000.0)));
        // A stage biased by one base resistor, which is the arrangement that walks
        // its operating point with temperature — so the gain correction is doing
        // something here rather than sitting at one.
        let model = BjtModel { temp: celsius + 273.15, ..BjtModel::npn() };
        c.add(Box::new(Bjt::new("Q1", col, base, Circuit::GROUND, model)));

        let mut sim = Simulator::default();
        let op = sim.operating_point(&mut c).unwrap();
        let at = |name: &str| op.solution[op.unknown_names.iter().position(|n| n == name).unwrap()];

        let mut currents = Vec::new();
        c.collect_currents(&op.solution, &mut currents);
        let names = c.element_names();
        let reported = currents[names.iter().position(|n| n == "Q1").unwrap()];

        (reported, (at("v(vcc)") - at("v(col)")) / 1000.0)
    }

    for celsius in [-40.0, 27.0, 125.0] {
        let (reported, through_load) = measured(celsius);
        assert!(through_load > 1e-4, "at {celsius} C the stage should be conducting");
        assert!(
            (reported - through_load).abs() / through_load < 1e-3,
            "at {celsius} C the transistor reports {reported:.6e} A \
             while its load carries {through_load:.6e} A"
        );
    }
}

/// A transistor's reported base current agrees with the net it is drawn on,
/// whichever way round the device is.
///
/// Adding to zero across the three terminals is not enough on its own: a figure
/// with the wrong sign on every terminal still adds to zero. This checks against
/// the circuit outside instead — everything leaving the base node has to balance
/// — and does it on the edge, where the current is entirely the junction
/// capacitances, since that is the part that carries the polarity.
#[test]
fn both_polarities_report_the_base_current_the_net_demands() {
    /// (what the device says, what the net demands), midway through the edge.
    fn measured(polarity: Polarity) -> (f64, f64) {
        let sign = if polarity == Polarity::Npn { 1.0 } else { -1.0 };
        let mut c = Circuit::new();
        let supply = c.node("supply");
        let col = c.node("col");
        let base = c.node("base");

        c.add(Box::new(VoltageSource::dc("V1", supply, Circuit::GROUND, 10.0 * sign)));
        c.add(Box::new(Resistor::new("RC", col, Circuit::GROUND, 1000.0)));
        c.add(Box::new(Resistor::new("RB", base, Circuit::GROUND, 1000.0)));
        // Held off, so the junctions conduct nothing and the base terminal is
        // carrying its capacitances and nothing else.
        c.add(Box::new(VoltageSource::new(
            "VB",
            base,
            Circuit::GROUND,
            Waveform::Pulse {
                v1: 0.0,
                v2: -0.8 * sign,
                delay: 1e-7,
                rise: 1e-8,
                fall: 1e-8,
                width: 2e-7,
                period: 0.0,
            },
        )));
        let model = if polarity == Polarity::Npn { BjtModel::npn() } else { BjtModel::pnp() };
        c.add(Box::new(Bjt::new("Q1", col, base, supply, model)));

        let result = Simulator::default().transient(&mut c, TransientConfig::new(4e-7)).unwrap();
        let k = result
            .time
            .iter()
            .position(|t| *t > 1.02e-7 && *t < 1.08e-7)
            .expect("a timepoint partway up the edge");

        let reported = result.currents[k][result.element_index("Q1:b").unwrap()];
        // KCL at the base node: what the source pushes in, less what the pull-down
        // takes, is what went into the transistor.
        let i_source = result.solution[k][result.index_of("i(VB)").unwrap()];
        let v_base = result.solution[k][result.index_of("v(base)").unwrap()];
        (reported, -i_source - v_base / 1000.0)
    }

    for polarity in [Polarity::Npn, Polarity::Pnp] {
        let (reported, demanded) = measured(polarity);
        assert!(demanded.abs() > 1e-6, "{polarity:?}: the edge should be carrying something");
        assert!(
            (reported - demanded).abs() / demanded.abs() < 0.01,
            "{polarity:?}: reports {reported:.6e} A into the base, the net demands {demanded:.6e} A"
        );
    }
}

/// The currents reported at a MOSFET's terminals add up to nothing.
///
/// Which is Kirchhoff, and the reason the drawing could not balance a net before
/// this: with only the channel current reported, a gate being charged through
/// 25 pF at a 5 V edge drew milliamps out of the supply that arrived nowhere.
/// The animation showed current leaving a source and reaching no part.
#[test]
fn a_mosfet_reports_every_terminal_it_is_carrying() {
    let mut c = Circuit::new();
    let vdd = c.node("vdd");
    let gate = c.node("gate");
    let drain = c.node("drain");
    c.add(Box::new(VoltageSource::dc("VDD", vdd, Circuit::GROUND, 5.0)));
    // A fast edge on the gate, which is where the capacitive current comes from.
    c.add(Box::new(VoltageSource::new(
        "V1",
        gate,
        Circuit::GROUND,
        Waveform::Pulse {
            v1: 0.0,
            v2: 5.0,
            delay: 1e-6,
            rise: 1e-8,
            fall: 1e-8,
            width: 5e-6,
            period: 0.0,
        },
    )));
    c.add(Box::new(Resistor::new("R1", vdd, drain, 1000.0)));
    let model = MosfetModel { channel: Channel::N, ..MosfetModel::default() };
    c.add(Box::new(Mosfet::new("M1", drain, gate, Circuit::GROUND, model)));

    let mut sim = Simulator::default();
    let mut cfg = TransientConfig::new(4e-6);
    cfg.max_step = 2e-9;
    let result = sim.transient(&mut c, cfg).unwrap();

    let index = |name: &str| result.element_index(name).unwrap_or_else(|| panic!("no {name}"));
    let (d, g, s) = (index("M1"), index("M1:g"), index("M1:s"));

    // Somewhere in the edge the gate is genuinely carrying something, or this
    // test would pass on a device that reports three zeroes.
    let peak_gate = result.currents.iter().map(|row| row[g].abs()).fold(0.0f64, f64::max);
    assert!(peak_gate > 1e-4, "the gate never drew anything: peak {peak_gate:.3e} A");

    for (row, t) in result.currents.iter().zip(&result.time) {
        let sum = row[d] + row[g] + row[s];
        let largest = row[d].abs().max(row[g].abs()).max(row[s].abs());
        assert!(
            sum.abs() <= largest * 1e-9 + 1e-12,
            "at t = {t:.3e} the terminals sum to {sum:.3e} A against {largest:.3e} A"
        );
    }
}

/// A settled capacitance stops carrying current, instead of reversing forever.
///
/// The reported symptom was dots on a wire going back and forth erratically
/// rather than flowing. They were: the trapezoidal rule, on a node whose time
/// constant is a thousandth of the step being taken, does not settle — it
/// alternates about the answer, one step each way, and the amplitude falls only
/// as the step grows. It is invisible on a voltage and unmissable on a current,
/// which is made of the difference between consecutive points.
///
/// Two things answer it: the reported current is the mean over the step, which
/// cannot ring by construction, and a branch caught alternating gets the next
/// step taken with backward Euler, which has no ringing in it.
#[test]
fn a_gate_that_has_finished_charging_stops_swapping_direction() {
    let mut c = Circuit::new();
    let vdd = c.node("vdd");
    let gate = c.node("gate");
    let drain = c.node("drain");
    c.add(Box::new(VoltageSource::dc("VDD", vdd, Circuit::GROUND, 5.0)));
    c.add(Box::new(VoltageSource::new(
        "V1",
        gate,
        Circuit::GROUND,
        Waveform::Pulse {
            v1: 0.0,
            v2: 5.0,
            delay: 10e-6,
            rise: 1e-8,
            fall: 1e-8,
            width: 50e-6,
            period: 100e-6,
        },
    )));
    c.add(Box::new(Resistor::new("R1", vdd, drain, 1000.0)));
    let model = MosfetModel { channel: Channel::N, ..MosfetModel::default() };
    c.add(Box::new(Mosfet::new("M1", drain, gate, Circuit::GROUND, model)));

    let result = Simulator::default().transient(&mut c, TransientConfig::new(40e-6)).unwrap();
    let g = result.element_index("M1:g").unwrap();

    // Counted only among currents big enough to be drawn at all: a reversal at
    // picoamps is below the threshold where anything moves on screen.
    let visible = 1e-9;
    let mut reversals = 0;
    let mut previous = 0.0f64;
    for (row, t) in result.currents.iter().zip(&result.time) {
        let i = row[g];
        if *t > 10.05e-6
            && i.abs() > visible
            && previous.abs() > visible
            && i.signum() != previous.signum()
        {
            reversals += 1;
        }
        previous = i;
    }
    // The edge itself reverses the current once, and the tail of a real decay
    // may cross zero once or twice on its way down. Sixty reversals is an
    // integrator talking to itself.
    assert!(reversals <= 8, "the gate current reversed {reversals} times after one edge");
}
