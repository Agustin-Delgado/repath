//! The circuit: analog elements, digital devices, and the bridges between them.

use std::collections::HashMap;

use crate::bridge::{AdcBridge, DacBridge, LogicFamily};
use crate::complex::{C64, ComplexSystem};
use crate::digital::{DigitalDevice, DigitalDomain, Logic, NetId};
use crate::element::{AcCtx, Element, Integration, NodeId, StampCtx};
use crate::elements::{Capacitor, CurrentSource, Inductor, Resistor, VoltageSource, Waveform};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// A new value for one element, from some instant of a run on.
///
/// Only the values that can change under a running circuit without it being a
/// different circuit: a resistance, a capacitance, an inductance, what a
/// source puts out. A part changing type or a wire moving is a new netlist,
/// and that is a new run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retune {
    Resistance(f64),
    Capacitance(f64),
    Inductance(f64),
    /// A voltage or current source's whole waveform. Its time is the run's,
    /// so a sine handed a new amplitude carries on at the phase it was at.
    Waveform(Waveform),
}

/// A retune waiting for the run to reach its instant.
#[derive(Debug, Clone)]
struct Scheduled {
    at: f64,
    element: usize,
    change: Retune,
}

/// Everything the simulator is asked to solve.
#[derive(Debug, Default)]
pub struct Circuit {
    node_names: Vec<String>,
    node_lookup: HashMap<String, NodeId>,
    elements: Vec<Box<dyn Element>>,
    dacs: Vec<DacBridge>,
    adcs: Vec<AdcBridge>,
    net_lookup: HashMap<String, NetId>,
    pub digital: DigitalDomain,
    extra_unknowns: usize,
    built: bool,
    /// Retunes not yet reached, in the order they fall due.
    retunes: Vec<Scheduled>,
}

impl Circuit {
    pub fn new() -> Self {
        Self {
            node_names: vec!["gnd".to_string()],
            node_lookup: HashMap::from([("gnd".to_string(), 0)]),
            ..Default::default()
        }
    }

    /// Ground is always node 0.
    pub const GROUND: NodeId = 0;

    /// Look up a node by name, creating it if it does not exist.
    pub fn node(&mut self, name: &str) -> NodeId {
        if let Some(id) = self.node_lookup.get(name) {
            return *id;
        }
        let id = self.node_names.len();
        self.node_names.push(name.to_string());
        self.node_lookup.insert(name.to_string(), id);
        self.built = false;
        id
    }

    pub fn node_id(&self, name: &str) -> Option<NodeId> {
        self.node_lookup.get(name).copied()
    }

    pub fn node_name(&self, node: NodeId) -> Option<&str> {
        self.node_names.get(node).map(String::as_str)
    }

    /// Number of nodes including ground.
    pub fn node_count(&self) -> usize {
        self.node_names.len()
    }

    pub fn add(&mut self, element: Box<dyn Element>) -> usize {
        self.built = false;
        self.elements.push(element);
        self.elements.len() - 1
    }

    pub fn elements(&self) -> &[Box<dyn Element>] {
        &self.elements
    }

    pub fn element_count(&self) -> usize {
        self.elements.len()
    }

    /// Look up a digital net by name, creating it if needed.
    pub fn net(&mut self, name: &str) -> NetId {
        if let Some(id) = self.net_lookup.get(name) {
            return *id;
        }
        let id = self.digital.add_net(name);
        self.net_lookup.insert(name.to_string(), id);
        id
    }

    pub fn net_id(&self, name: &str) -> Option<NetId> {
        self.net_lookup.get(name).copied()
    }

    pub fn add_device(&mut self, device: Box<dyn DigitalDevice>) -> usize {
        self.digital.add_device(device)
    }

    /// Let an analog node drive a digital net.
    pub fn bridge_to_digital(
        &mut self,
        name: impl Into<String>,
        node: NodeId,
        net: NetId,
        family: LogicFamily,
    ) -> usize {
        let driver = self.digital.add_external_driver(net);
        self.adcs.push(AdcBridge::new(name, node, net, family, driver));
        self.adcs.len() - 1
    }

    /// Let a digital net drive an analog node.
    pub fn bridge_to_analog(
        &mut self,
        name: impl Into<String>,
        net: NetId,
        node: NodeId,
        family: LogicFamily,
    ) -> usize {
        self.built = false;
        self.dacs.push(DacBridge::new(name, net, node, family));
        self.dacs.len() - 1
    }

    pub fn dacs(&self) -> &[DacBridge] {
        &self.dacs
    }

    pub fn adcs(&self) -> &[AdcBridge] {
        &self.adcs
    }

    pub(crate) fn dacs_mut(&mut self) -> &mut [DacBridge] {
        &mut self.dacs
    }

    pub(crate) fn adcs_mut(&mut self) -> &mut [AdcBridge] {
        &mut self.adcs
    }

    /// Assign matrix indices to every branch-current unknown.
    ///
    /// Node voltages occupy `0 .. node_count-1`; everything after that belongs to
    /// elements that had to add an unknown of their own.
    pub fn build(&mut self) {
        let mut next = self.node_names.len().saturating_sub(1);
        for element in &mut self.elements {
            let extra = element.extra_unknowns();
            if extra > 0 {
                element.bind(next);
                next += extra;
            }
        }
        self.extra_unknowns = next - self.node_names.len().saturating_sub(1);
        self.built = true;
    }

    /// Size of the MNA system.
    pub fn unknown_count(&self) -> usize {
        self.node_names.len().saturating_sub(1) + self.extra_unknowns
    }

    /// Human-readable label for each unknown, for probing and debugging.
    pub fn unknown_names(&self) -> Vec<String> {
        let mut names: Vec<String> =
            self.node_names[1..].iter().map(|n| format!("v({n})")).collect();
        for element in &self.elements {
            for k in 0..element.extra_unknowns() {
                names.push(match element.extra_unknown_name(k) {
                    Some(label) => format!("{}.{label}", element.name()),
                    None if element.extra_unknowns() == 1 => format!("i({})", element.name()),
                    None => format!("i({}.{k})", element.name()),
                });
            }
        }
        names
    }

    pub fn is_built(&self) -> bool {
        self.built
    }

    /// Whether any element needs Newton iteration.
    pub fn has_nonlinear(&self) -> bool {
        self.elements.iter().any(|e| e.is_nonlinear())
    }

    /// Whether any element carries state across timesteps.
    pub fn has_reactive(&self) -> bool {
        self.elements.iter().any(|e| e.is_reactive())
    }

    /// Stamp every element and DAC bridge into `sys`.
    ///
    /// An element marked in `damped` is stamped with backward Euler whatever
    /// rule `ctx` names: damping is decided element by element, so a corner in
    /// one part of the drawing does not cost the rest of it its accuracy.
    ///
    /// Returns true if any element limited itself this iteration, which blocks
    /// Newton from declaring convergence.
    pub(crate) fn stamp_all(
        &mut self,
        sys: &mut LinearSystem,
        ctx: &StampCtx,
        damped: &[bool],
    ) -> bool {
        let mut limited = false;
        let euler = StampCtx { integration: Integration::BackwardEuler, ..*ctx };
        for (k, element) in self.elements.iter_mut().enumerate() {
            let ctx = if damped.get(k).copied().unwrap_or(false) { &euler } else { ctx };
            limited |= element.stamp(sys, ctx).limited;
        }
        for dac in &mut self.dacs {
            dac.stamp(sys, ctx);
        }

        // gmin from every node to ground. Without it a circuit with a floating
        // node — an unconnected op-amp input, a MOSFET in cutoff — gives a
        // singular matrix, and users produce those constantly while drawing.
        let node_rows = self.node_names.len().saturating_sub(1);
        for i in 0..node_rows {
            sys.add(Some(i), Some(i), ctx.gmin);
        }
        limited
    }

    /// Stamp every element's small-signal contribution at one frequency.
    pub(crate) fn ac_stamp_all(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        for element in &self.elements {
            element.ac_stamp(sys, ctx);
        }
        for dac in &self.dacs {
            dac.ac_stamp(sys, ctx);
        }

        let node_rows = self.node_names.len().saturating_sub(1);
        for i in 0..node_rows {
            sys.add(Some(i), Some(i), C64::real(ctx.gmin));
        }
    }

    /// Mutable access to the elements, for editing values between runs.
    /// Downcast through [`crate::element::AsAny`] to reach a concrete type.
    pub fn elements_mut(&mut self) -> &mut [Box<dyn Element>] {
        &mut self.elements
    }

    /// Current through an element, if it can report one.
    pub fn element_current(&self, index: usize, x: &[f64]) -> Option<f64> {
        self.elements.get(index)?.current(x)
    }

    /// Instance names, in the same order as [`Self::collect_currents`].
    /// Names for every reported current, in the order [`Self::collect_currents`]
    /// produces them: each element, then any extra terminals it reports, as
    /// `M1:g`. After the elements, the supply legs of every bridge that draws
    /// its output current through a package's supply, as `BDA3:p1`, `BDA3:m1`.
    pub fn element_names(&self) -> Vec<String> {
        let mut names = Vec::with_capacity(self.elements.len());
        for element in &self.elements {
            names.push(element.name().to_string());
            for terminal in element.terminal_names() {
                names.push(format!("{}:{terminal}", element.name()));
            }
        }
        for dac in &self.dacs {
            names.extend(dac.tap_names());
        }
        names
    }

    /// Current through every element, in element order, then each bridge's
    /// supply legs, at the solution `x` solved for the instant `t`.
    ///
    /// Recorded per timepoint so a viewer can show current flowing without
    /// having to re-derive device physics it should not have to know about.
    /// Elements that cannot report a current contribute zero.
    pub fn collect_currents(&self, x: &[f64], t: f64, out: &mut Vec<f64>) {
        out.clear();
        out.reserve(self.elements.len());
        for element in &self.elements {
            out.push(element.current(x).unwrap_or(0.0));
            element.terminal_currents(x, out);
        }
        for dac in &self.dacs {
            dac.tap_currents(x, t, out);
        }
    }

    /// Discard all history so the next run starts from scratch.
    pub fn reset(&mut self) {
        self.reset_elements();
        for dac in &mut self.dacs {
            dac.reset();
        }
        for adc in &mut self.adcs {
            adc.reset();
        }
        self.digital.reset();
    }

    /// Put every analog element back to where it started, and nothing else.
    ///
    /// What a convergence aid starting over needs: the junction voltages a
    /// failed attempt left behind are gone, while the logic the attempt was
    /// solved around, and the levels the bridges hold from it, stay.
    pub(crate) fn reset_elements(&mut self) {
        for element in &mut self.elements {
            element.reset();
        }
    }

    /// Resolved state of a digital net.
    pub fn net_state(&self, net: NetId) -> Logic {
        self.digital.state(net)
    }

    /// Give a voltage source a new waveform in the middle of a run.
    ///
    /// This is somebody's hand on a switch. The waveform a switch's actuator
    /// carries is written from the instant it is thrown, so the run keeps every
    /// timepoint solved before then and the contact moves from here on — which is
    /// what makes an operation an event in the circuit's life rather than a
    /// different circuit that has to be solved from the beginning.
    ///
    /// Returns whether a source by that name was found.
    pub fn set_source_waveform(&mut self, name: &str, waveform: Waveform) -> bool {
        for element in &mut self.elements {
            if element.name() != name {
                continue;
            }
            if let Some(source) = element.as_any_mut().downcast_mut::<VoltageSource>() {
                source.waveform = waveform;
                return true;
            }
        }
        false
    }

    /// Put a new waveform into a voltage or a current source, and hand back
    /// the one it had, or `None` if there is no source by that name.
    ///
    /// What a DC sweep turns: unlike [`Self::set_source_waveform`] it reaches
    /// current sources too, since an I-V curve is as often driven by one.
    pub fn swap_source_waveform(&mut self, name: &str, waveform: Waveform) -> Option<Waveform> {
        let element = self.elements.iter_mut().find(|e| e.name() == name)?;
        let any = element.as_any_mut();
        if let Some(source) = any.downcast_mut::<VoltageSource>() {
            return Some(std::mem::replace(&mut source.waveform, waveform));
        }
        if let Some(source) = any.downcast_mut::<CurrentSource>() {
            return Some(std::mem::replace(&mut source.waveform, waveform));
        }
        None
    }

    /// Give an element a new value from `at` onwards — a hand on a knob.
    ///
    /// Like [`Self::operate_logic`], an instant rather than "now": the solver
    /// treats it as a corner, ends a step exactly on it and changes the value
    /// there, so a run handed the same retunes up front lands on the same
    /// instants as the one they were made on live. An instant already reached
    /// takes effect from the next step. Everything solved before it stays
    /// solved; what the element stores — a capacitor's charge, an inductor's
    /// flux — carries across, so the voltage across a capacitor turned down
    /// rises, as it does on the bench.
    ///
    /// Returns false, and schedules nothing, when there is no element by that
    /// name, the change does not fit it, or the value is not a positive number.
    pub fn retune(&mut self, name: &str, change: Retune, at: f64) -> bool {
        let Some(element) = self.elements.iter().position(|e| e.name() == name) else {
            return false;
        };
        let any = (*self.elements[element]).as_any();
        let fits = match &change {
            Retune::Resistance(_) => any.is::<Resistor>(),
            Retune::Capacitance(_) => any.is::<Capacitor>(),
            Retune::Inductance(_) => any.is::<Inductor>(),
            Retune::Waveform(_) => any.is::<VoltageSource>() || any.is::<CurrentSource>(),
        };
        let valid = match &change {
            Retune::Resistance(v) | Retune::Capacitance(v) | Retune::Inductance(v) => {
                v.is_finite() && *v > 0.0
            }
            Retune::Waveform(_) => true,
        };
        if !fits || !valid || !at.is_finite() {
            return false;
        }
        // After everything due at the same instant or earlier, so two edits at
        // one instant apply in the order they were made.
        let index = self.retunes.partition_point(|r| r.at <= at);
        self.retunes.insert(index, Scheduled { at, element, change });
        true
    }

    /// When the next retune falls due, if any is waiting.
    pub fn next_retune(&self) -> Option<f64> {
        self.retunes.first().map(|r| r.at)
    }

    /// Apply every retune due by `t`. Returns the elements changed, in the order
    /// they were, empty when nothing was due.
    pub(crate) fn apply_retunes(&mut self, t: f64) -> Vec<usize> {
        let due = self.retunes.partition_point(|r| r.at <= t);
        if due == 0 {
            return Vec::new();
        }
        let mut changed = Vec::with_capacity(due);
        for Scheduled { element, change, .. } in self.retunes.drain(..due) {
            changed.push(element);
            let any = (*self.elements[element]).as_any_mut();
            match change {
                Retune::Resistance(r) => {
                    if let Some(resistor) = any.downcast_mut::<Resistor>() {
                        resistor.r = r;
                    }
                }
                Retune::Capacitance(c) => {
                    if let Some(capacitor) = any.downcast_mut::<Capacitor>() {
                        capacitor.set_capacitance(c);
                    }
                }
                Retune::Inductance(l) => {
                    if let Some(inductor) = any.downcast_mut::<Inductor>() {
                        inductor.set_inductance(l);
                    }
                }
                Retune::Waveform(waveform) => {
                    if let Some(source) = any.downcast_mut::<VoltageSource>() {
                        source.waveform = waveform;
                    } else if let Some(source) = any.downcast_mut::<CurrentSource>() {
                        source.waveform = waveform;
                    }
                }
            }
        }
        changed
    }

    /// Move a named logic source to a level, from `at` onwards.
    pub fn operate_logic(&mut self, name: &str, state: Logic, at: f64) -> bool {
        self.digital.operate(name, state, at)
    }

    /// Send bytes from a USB-serial converter, by name, from `at` onwards at
    /// `baud`: what typing into a serial monitor does. Returns when the last
    /// byte's stop bit ends, or `None` if there is no converter by that name.
    pub fn send_serial(&mut self, name: &str, bytes: &[u8], baud: u32, at: f64) -> Option<f64> {
        self.digital
            .act_on(name, at, |port: &mut crate::avr::UsbSerial, ctx| port.send(ctx, bytes, baud))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elements::{Resistor, VoltageSource};

    #[test]
    fn ground_is_node_zero_and_is_reused() {
        let mut c = Circuit::new();
        assert_eq!(c.node("gnd"), 0);
        assert_eq!(c.node("out"), 1);
        assert_eq!(c.node("out"), 1);
        assert_eq!(c.node_count(), 2);
    }

    #[test]
    fn branch_unknowns_come_after_node_voltages() {
        let mut c = Circuit::new();
        let a = c.node("a");
        let b = c.node("b");
        c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 5.0)));
        c.add(Box::new(Resistor::new("R1", a, b, 1000.0)));
        c.add(Box::new(VoltageSource::dc("V2", b, Circuit::GROUND, 1.0)));
        c.build();

        // Two node voltages plus two source currents.
        assert_eq!(c.unknown_count(), 4);
        assert_eq!(c.unknown_names(), vec!["v(a)", "v(b)", "i(V1)", "i(V2)"]);
    }

    #[test]
    fn rebuilding_after_adding_elements_does_not_leak_indices() {
        let mut c = Circuit::new();
        let a = c.node("a");
        c.add(Box::new(VoltageSource::dc("V1", a, Circuit::GROUND, 5.0)));
        c.build();
        assert_eq!(c.unknown_count(), 2);

        let b = c.node("b");
        c.add(Box::new(VoltageSource::dc("V2", b, Circuit::GROUND, 5.0)));
        c.build();
        assert_eq!(c.unknown_count(), 4);
    }
}
