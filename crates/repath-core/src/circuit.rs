//! The circuit: analog elements, digital devices, and the bridges between them.

use std::collections::HashMap;

use crate::bridge::{AdcBridge, DacBridge, LogicFamily};
use crate::digital::{DigitalDevice, DigitalDomain, Logic, NetId};
use crate::element::{Element, NodeId, StampCtx};
use crate::linalg::LinearSystem;

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
                names.push(if element.extra_unknowns() == 1 {
                    format!("i({})", element.name())
                } else {
                    format!("i({}.{k})", element.name())
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
    /// Returns true if any element limited itself this iteration, which blocks
    /// Newton from declaring convergence.
    pub(crate) fn stamp_all(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> bool {
        let mut limited = false;
        for element in &mut self.elements {
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
    pub fn element_names(&self) -> Vec<String> {
        self.elements.iter().map(|e| e.name().to_string()).collect()
    }

    /// Current through every element, in element order.
    ///
    /// Recorded per timepoint so a viewer can show current flowing without
    /// having to re-derive device physics it should not have to know about.
    /// Elements that cannot report a current contribute zero.
    pub fn collect_currents(&self, x: &[f64], out: &mut Vec<f64>) {
        out.clear();
        out.reserve(self.elements.len());
        for element in &self.elements {
            out.push(element.current(x).unwrap_or(0.0));
        }
    }

    /// Discard all history so the next run starts from scratch.
    pub fn reset(&mut self) {
        for element in &mut self.elements {
            element.reset();
        }
        for dac in &mut self.dacs {
            dac.reset();
        }
        for adc in &mut self.adcs {
            adc.reset();
        }
        self.digital.reset();
    }

    /// Resolved state of a digital net.
    pub fn net_state(&self, net: NetId) -> Logic {
        self.digital.state(net)
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
