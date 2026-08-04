//! A serializable circuit description.
//!
//! This is the wire format between the editor and the engine. It refers to nodes
//! and nets by name so the editor never has to know about matrix indices, and it
//! is the only place where a malformed circuit is turned into a readable error
//! rather than a panic deep inside the solver.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::bridge::LogicFamily;
use crate::circuit::Circuit;
use crate::digital::{Clock, DFlipFlop, Gate, GateKind, TriStateBuffer};
use crate::element::NodeId;
use crate::elements::{
    Bjt, BjtModel, Capacitor, CurrentSource, Diode, DiodeModel, Inductor, Mosfet, MosfetModel,
    OpAmp, OpAmpModel, Resistor, Switch, SwitchModel, Vccs, Vcvs, VoltageSource, Waveform,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetlistError {
    Empty,
    DuplicateName(String),
    /// A gate or device was given a terminal list it cannot use.
    BadTerminals {
        component: String,
        reason: String,
    },
}

impl std::fmt::Display for NetlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetlistError::Empty => write!(f, "the netlist has no components"),
            NetlistError::DuplicateName(n) => write!(f, "two components are both named '{n}'"),
            NetlistError::BadTerminals { component, reason } => {
                write!(f, "{component}: {reason}")
            }
        }
    }
}

impl std::error::Error for NetlistError {}

fn default_gate_delay() -> f64 {
    1e-9
}

fn default_duty() -> f64 {
    0.5
}

/// An analog component.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Component {
    Resistor {
        name: String,
        a: String,
        b: String,
        resistance: f64,
    },
    Capacitor {
        name: String,
        a: String,
        b: String,
        capacitance: f64,
        #[serde(default)]
        initial_voltage: Option<f64>,
    },
    Inductor {
        name: String,
        a: String,
        b: String,
        inductance: f64,
        #[serde(default)]
        initial_current: Option<f64>,
    },
    VoltageSource {
        name: String,
        plus: String,
        minus: String,
        waveform: Waveform,
        /// Small-signal drive for AC analysis. Absent or zero means this source
        /// supplies bias only — a rail should not also inject a signal.
        #[serde(default)]
        ac_magnitude: f64,
        /// Phase of that drive, in degrees.
        #[serde(default)]
        ac_phase: f64,
    },
    CurrentSource {
        name: String,
        plus: String,
        minus: String,
        waveform: Waveform,
        #[serde(default)]
        ac_magnitude: f64,
        #[serde(default)]
        ac_phase: f64,
    },
    Diode {
        name: String,
        anode: String,
        cathode: String,
        #[serde(default)]
        model: DiodeModel,
    },
    Mosfet {
        name: String,
        drain: String,
        gate: String,
        source: String,
        #[serde(default)]
        model: MosfetModel,
    },
    Bjt {
        name: String,
        collector: String,
        base: String,
        emitter: String,
        #[serde(default)]
        model: BjtModel,
    },
    OpAmp {
        name: String,
        output: String,
        input_plus: String,
        input_minus: String,
        #[serde(default = "default_opamp_gain")]
        gain: f64,
        #[serde(default = "default_vmax")]
        v_max: f64,
        #[serde(default = "default_vmin")]
        v_min: f64,
        /// Gain-bandwidth product, slew rate, output resistance, input offset and
        /// input bias current. Each defaults to a general-purpose part rather than
        /// to nothing: an op-amp with no bandwidth limit and no slew rate is not a
        /// simpler op-amp, it is one that makes unstable circuits look stable.
        #[serde(default = "default_gbw")]
        gbw: f64,
        #[serde(default = "default_slew")]
        slew: f64,
        #[serde(default = "default_r_out")]
        r_out: f64,
        #[serde(default = "default_v_os")]
        v_os: f64,
        #[serde(default = "default_i_bias")]
        i_bias: f64,
    },
    Switch {
        name: String,
        a: String,
        b: String,
        control_plus: String,
        control_minus: String,
        #[serde(default)]
        model: SwitchModel,
    },
    Vcvs {
        name: String,
        plus: String,
        minus: String,
        control_plus: String,
        control_minus: String,
        gain: f64,
    },
    Vccs {
        name: String,
        plus: String,
        minus: String,
        control_plus: String,
        control_minus: String,
        transconductance: f64,
    },
}

fn default_opamp_gain() -> f64 {
    1e5
}
fn default_vmax() -> f64 {
    15.0
}
fn default_vmin() -> f64 {
    -15.0
}

// A general-purpose bipolar part, near enough a 741. Kept beside the rails they
// belong with rather than derived from `OpAmpModel::default`, because serde needs
// a function per field and a wrong one here is a silent difference between what a
// caller wrote and what gets built.
fn default_gbw() -> f64 {
    1e6
}

fn default_slew() -> f64 {
    0.5e6
}

fn default_r_out() -> f64 {
    75.0
}

fn default_v_os() -> f64 {
    1e-3
}

fn default_i_bias() -> f64 {
    80e-9
}

impl Component {
    pub fn name(&self) -> &str {
        match self {
            Component::Resistor { name, .. }
            | Component::Capacitor { name, .. }
            | Component::Inductor { name, .. }
            | Component::VoltageSource { name, .. }
            | Component::CurrentSource { name, .. }
            | Component::Diode { name, .. }
            | Component::Mosfet { name, .. }
            | Component::Bjt { name, .. }
            | Component::OpAmp { name, .. }
            | Component::Switch { name, .. }
            | Component::Vcvs { name, .. }
            | Component::Vccs { name, .. } => name,
        }
    }
}

/// A digital device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Device {
    Gate {
        name: String,
        kind: GateKind,
        inputs: Vec<String>,
        output: String,
        #[serde(default = "default_gate_delay")]
        delay: f64,
    },
    Clock {
        name: String,
        output: String,
        frequency: f64,
        #[serde(default = "default_duty")]
        duty: f64,
    },
    DFlipFlop {
        name: String,
        clock: String,
        data: String,
        #[serde(default)]
        reset: Option<String>,
        q: String,
        q_not: String,
        #[serde(default = "default_gate_delay")]
        delay: f64,
    },
    TriState {
        name: String,
        input: String,
        enable: String,
        output: String,
        #[serde(default = "default_gate_delay")]
        delay: f64,
    },
}

impl Device {
    pub fn name(&self) -> &str {
        match self {
            Device::Gate { name, .. }
            | Device::Clock { name, .. }
            | Device::DFlipFlop { name, .. }
            | Device::TriState { name, .. } => name,
        }
    }
}

/// A connection between the two domains.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum Bridge {
    /// Analog node drives a digital net.
    ToDigital {
        name: String,
        node: String,
        net: String,
        #[serde(default)]
        family: Option<LogicFamily>,
        #[serde(default)]
        delay: f64,
    },
    /// Digital net drives an analog node.
    ToAnalog {
        name: String,
        net: String,
        node: String,
        #[serde(default)]
        family: Option<LogicFamily>,
    },
}

impl Bridge {
    pub fn name(&self) -> &str {
        match self {
            Bridge::ToDigital { name, .. } | Bridge::ToAnalog { name, .. } => name,
        }
    }
}

/// A complete circuit, ready to be compiled and simulated.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Netlist {
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub bridges: Vec<Bridge>,
    /// Logic thresholds used by any bridge that does not override them.
    #[serde(default)]
    pub logic_family: LogicFamily,
}

/// Names that always mean ground, whatever case the user typed.
fn is_ground(name: &str) -> bool {
    matches!(name.trim().to_ascii_lowercase().as_str(), "0" | "gnd" | "ground" | "vss")
}

impl Netlist {
    /// Turn this description into a solvable [`Circuit`].
    pub fn compile(&self) -> Result<Circuit, NetlistError> {
        if self.components.is_empty() && self.devices.is_empty() {
            return Err(NetlistError::Empty);
        }

        let mut seen = HashSet::new();
        for name in self
            .components
            .iter()
            .map(Component::name)
            .chain(self.devices.iter().map(Device::name))
            .chain(self.bridges.iter().map(Bridge::name))
        {
            if !seen.insert(name.to_string()) {
                return Err(NetlistError::DuplicateName(name.to_string()));
            }
        }

        let mut circuit = Circuit::new();

        for component in &self.components {
            self.add_component(&mut circuit, component)?;
        }
        for device in &self.devices {
            self.add_device(&mut circuit, device)?;
        }
        for bridge in &self.bridges {
            self.add_bridge(&mut circuit, bridge);
        }

        circuit.build();
        Ok(circuit)
    }

    fn node(&self, circuit: &mut Circuit, name: &str) -> NodeId {
        if is_ground(name) { Circuit::GROUND } else { circuit.node(name) }
    }

    fn add_component(&self, c: &mut Circuit, comp: &Component) -> Result<(), NetlistError> {
        match comp {
            Component::Resistor { name, a, b, resistance } => {
                let (a, b) = (self.node(c, a), self.node(c, b));
                c.add(Box::new(Resistor::new(name, a, b, *resistance)));
            }
            Component::Capacitor { name, a, b, capacitance, initial_voltage } => {
                let (a, b) = (self.node(c, a), self.node(c, b));
                let mut cap = Capacitor::new(name, a, b, *capacitance);
                if let Some(v) = initial_voltage {
                    cap = cap.with_ic(*v);
                }
                c.add(Box::new(cap));
            }
            Component::Inductor { name, a, b, inductance, initial_current } => {
                let (a, b) = (self.node(c, a), self.node(c, b));
                let mut ind = Inductor::new(name, a, b, *inductance);
                if let Some(i) = initial_current {
                    ind = ind.with_ic(*i);
                }
                c.add(Box::new(ind));
            }
            Component::VoltageSource { name, plus, minus, waveform, ac_magnitude, ac_phase } => {
                let (p, m) = (self.node(c, plus), self.node(c, minus));
                let mut source = VoltageSource::new(name, p, m, waveform.clone());
                source.ac_magnitude = *ac_magnitude;
                source.ac_phase = *ac_phase;
                c.add(Box::new(source));
            }
            Component::CurrentSource { name, plus, minus, waveform, ac_magnitude, ac_phase } => {
                let (p, m) = (self.node(c, plus), self.node(c, minus));
                let mut source = CurrentSource::new(name, p, m, waveform.clone());
                source.ac_magnitude = *ac_magnitude;
                source.ac_phase = *ac_phase;
                c.add(Box::new(source));
            }
            Component::Diode { name, anode, cathode, model } => {
                let (a, k) = (self.node(c, anode), self.node(c, cathode));
                c.add(Box::new(Diode::new(name, a, k, *model)));
            }
            Component::Mosfet { name, drain, gate, source, model } => {
                let (d, g, s) = (self.node(c, drain), self.node(c, gate), self.node(c, source));
                c.add(Box::new(Mosfet::new(name, d, g, s, *model)));
            }
            Component::Bjt { name, collector, base, emitter, model } => {
                let (col, b, e) =
                    (self.node(c, collector), self.node(c, base), self.node(c, emitter));
                c.add(Box::new(Bjt::new(name, col, b, e, *model)));
            }
            Component::OpAmp {
                name,
                output,
                input_plus,
                input_minus,
                gain,
                v_max,
                v_min,
                gbw,
                slew,
                r_out,
                v_os,
                i_bias,
            } => {
                let (o, p, n) =
                    (self.node(c, output), self.node(c, input_plus), self.node(c, input_minus));
                let model = OpAmpModel {
                    gain: *gain,
                    gbw: *gbw,
                    slew: *slew,
                    r_out: *r_out,
                    v_os: *v_os,
                    i_bias: *i_bias,
                    v_max: *v_max,
                    v_min: *v_min,
                };
                c.add(Box::new(OpAmp::new(name, o, p, n).with_model(model)));
            }
            Component::Switch { name, a, b, control_plus, control_minus, model } => {
                let (a, b) = (self.node(c, a), self.node(c, b));
                let (cp, cm) = (self.node(c, control_plus), self.node(c, control_minus));
                c.add(Box::new(Switch::new(name, a, b, cp, cm, *model)));
            }
            Component::Vcvs { name, plus, minus, control_plus, control_minus, gain } => {
                let (p, m) = (self.node(c, plus), self.node(c, minus));
                let (cp, cm) = (self.node(c, control_plus), self.node(c, control_minus));
                c.add(Box::new(Vcvs::new(name, p, m, cp, cm, *gain)));
            }
            Component::Vccs {
                name,
                plus,
                minus,
                control_plus,
                control_minus,
                transconductance,
            } => {
                let (p, m) = (self.node(c, plus), self.node(c, minus));
                let (cp, cm) = (self.node(c, control_plus), self.node(c, control_minus));
                c.add(Box::new(Vccs::new(name, p, m, cp, cm, *transconductance)));
            }
        }
        Ok(())
    }

    fn add_device(&self, c: &mut Circuit, device: &Device) -> Result<(), NetlistError> {
        match device {
            Device::Gate { name, kind, inputs, output, delay } => {
                if inputs.is_empty() {
                    return Err(NetlistError::BadTerminals {
                        component: name.clone(),
                        reason: "a gate needs at least one input".into(),
                    });
                }
                if matches!(kind, GateKind::Not | GateKind::Buffer) && inputs.len() != 1 {
                    return Err(NetlistError::BadTerminals {
                        component: name.clone(),
                        reason: format!("{kind:?} takes exactly one input, got {}", inputs.len()),
                    });
                }
                let ins: Vec<_> = inputs.iter().map(|n| c.net(n)).collect();
                let out = c.net(output);
                c.add_device(Box::new(Gate::new(name, *kind, ins, out, *delay)));
            }
            Device::Clock { name, output, frequency, duty } => {
                if *frequency <= 0.0 {
                    return Err(NetlistError::BadTerminals {
                        component: name.clone(),
                        reason: "clock frequency must be positive".into(),
                    });
                }
                let out = c.net(output);
                c.add_device(Box::new(Clock::new(name, out, *frequency, *duty)));
            }
            Device::DFlipFlop { name, clock, data, reset, q, q_not, delay } => {
                let clk = c.net(clock);
                let d = c.net(data);
                let rst = reset.as_ref().map(|n| c.net(n));
                let (q, qn) = (c.net(q), c.net(q_not));
                c.add_device(Box::new(DFlipFlop::new(name, clk, d, rst, q, qn, *delay)));
            }
            Device::TriState { name, input, enable, output, delay } => {
                let (i, e, o) = (c.net(input), c.net(enable), c.net(output));
                c.add_device(Box::new(TriStateBuffer::new(name, i, e, o, *delay)));
            }
        }
        Ok(())
    }

    fn add_bridge(&self, c: &mut Circuit, bridge: &Bridge) {
        match bridge {
            Bridge::ToDigital { name, node, net, family, delay } => {
                let node = self.node(c, node);
                let net = c.net(net);
                let family = family.unwrap_or(self.logic_family);
                let index = c.bridge_to_digital(name, node, net, family);
                c.adcs_mut()[index].delay = *delay;
            }
            Bridge::ToAnalog { name, net, node, family } => {
                let node = self.node(c, node);
                let net = c.net(net);
                let family = family.unwrap_or(self.logic_family);
                c.bridge_to_analog(name, net, node, family);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn divider() -> Netlist {
        Netlist {
            components: vec![
                Component::VoltageSource {
                    name: "V1".into(),
                    plus: "in".into(),
                    minus: "gnd".into(),
                    waveform: Waveform::Dc { value: 10.0 },
                    ac_magnitude: 0.0,
                    ac_phase: 0.0,
                },
                Component::Resistor {
                    name: "R1".into(),
                    a: "in".into(),
                    b: "out".into(),
                    resistance: 1000.0,
                },
                Component::Resistor {
                    name: "R2".into(),
                    a: "out".into(),
                    b: "0".into(),
                    resistance: 3000.0,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn compiles_a_divider() {
        let circuit = divider().compile().unwrap();
        // Two named nodes plus ground.
        assert_eq!(circuit.node_count(), 3);
        assert_eq!(circuit.element_count(), 3);
    }

    #[test]
    fn every_spelling_of_ground_is_the_same_node() {
        for name in ["gnd", "GND", "0", "ground", "VSS"] {
            let mut nl = divider();
            if let Component::Resistor { b, .. } = &mut nl.components[2] {
                *b = name.into();
            }
            let circuit = nl.compile().unwrap();
            assert_eq!(circuit.node_count(), 3, "'{name}' should have been ground");
        }
    }

    #[test]
    fn duplicate_names_are_rejected() {
        let mut nl = divider();
        if let Component::Resistor { name, .. } = &mut nl.components[2] {
            *name = "R1".into();
        }
        assert_eq!(nl.compile().unwrap_err(), NetlistError::DuplicateName("R1".into()));
    }

    #[test]
    fn an_inverter_with_two_inputs_is_rejected() {
        let nl = Netlist {
            devices: vec![Device::Gate {
                name: "N1".into(),
                kind: GateKind::Not,
                inputs: vec!["a".into(), "b".into()],
                output: "y".into(),
                delay: 1e-9,
            }],
            ..Default::default()
        };
        assert!(matches!(nl.compile(), Err(NetlistError::BadTerminals { .. })));
    }

    #[test]
    fn empty_netlists_are_rejected() {
        assert_eq!(Netlist::default().compile().unwrap_err(), NetlistError::Empty);
    }

    #[test]
    fn round_trips_through_json() {
        let nl = divider();
        let json = serde_json::to_string(&nl).unwrap();
        let back: Netlist = serde_json::from_str(&json).unwrap();
        assert_eq!(nl, back);
    }
}
