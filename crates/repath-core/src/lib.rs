//! # repath-core
//!
//! A mixed-signal circuit simulation engine.
//!
//! The analog side uses modified nodal analysis: every element stamps its
//! contribution into a matrix, Newton-Raphson handles the nonlinear devices, and
//! companion models turn capacitors and inductors into resistors plus a source
//! carrying history. The digital side is event-driven and only runs when
//! something changes. Bridges tie the two together without either side ever
//! seeing a discontinuity.
//!
//! ```
//! use repath_core::prelude::*;
//!
//! let mut circuit = Circuit::new();
//! let vin = circuit.node("vin");
//! let out = circuit.node("out");
//!
//! circuit.add(Box::new(VoltageSource::dc("V1", vin, Circuit::GROUND, 5.0)));
//! circuit.add(Box::new(Resistor::new("R1", vin, out, 1_000.0)));
//! circuit.add(Box::new(Resistor::new("R2", out, Circuit::GROUND, 1_000.0)));
//!
//! let mut sim = Simulator::default();
//! let op = sim.operating_point(&mut circuit).unwrap();
//! let out_index = op.unknown_names.iter().position(|n| n == "v(out)").unwrap();
//! // Not exactly 2.5: gmin puts a 1 pS leak on every node, by design.
//! assert!((op.solution[out_index] - 2.5).abs() < 1e-6);
//! ```

pub mod bridge;
pub mod circuit;
pub mod complex;
pub mod digital;
pub mod element;
pub mod elements;
pub mod linalg;
pub mod lte;
pub mod netlist;
pub mod solver;

/// Everything you need to build and run a circuit.
pub mod prelude {
    pub use crate::bridge::{AdcBridge, DacBridge, LogicFamily};
    pub use crate::circuit::Circuit;
    pub use crate::digital::{
        Clock, DFlipFlop, DigitalDevice, Gate, GateKind, Logic, NetId, TriStateBuffer,
    };
    pub use crate::element::{Element, Integration, Mode, NodeId};
    pub use crate::elements::{
        BURN_TIME, Bjt, BjtModel, Capacitor, Channel, CurrentSource, Diode, DiodeModel, Failure,
        Inductor, Mosfet, MosfetModel, OpAmp, Polarity, Resistor, Switch, SwitchModel, Vccs, Vcvs,
        VoltageSource, Waveform,
    };
    pub use crate::netlist::{Netlist, NetlistError};
    pub use crate::solver::{
        AcConfig, AcResult, OperatingPoint, SimError, Simulator, SolverConfig, TransientConfig,
        TransientResult,
    };
}
