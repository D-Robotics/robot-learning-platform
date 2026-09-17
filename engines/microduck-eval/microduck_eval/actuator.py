"""BAM XL330 voltage-control actuator, ported to pure numpy for the CPU harness.

Why this exists: the MJCF files that mjlab loads still contain a *placeholder*
position actuator (``kp = 0.55``), because training replaces it with BAM's
voltage-control model (``src/mjlab_microduck/robot/microduck_constants.py``:
``kp_fw=200``, i.e. an effective duty gain of ``200 * error_gain ≈ 1.15`` and a
stall torque of ``vin * kt / R ≈ 0.98 N·m``). Stepping the raw MJCF therefore
runs a robot ~200x weaker than the one the policy was trained on, and *nothing*
survives — which is what the first evaluation run measured.

The torque math is the reference implementation from ``bam.actuator``
(``VoltageControlledActuator``), evaluated on scalars instead of torch batches:

    duty = clamp(clamp(kp * error_gain * (q_target - q), duty_min, duty_max), -1, 1)
    tau  = (kt / R) * duty * vin - (kt**2 / R) * dq

with the firmware current limit expressed as a duty-cycle window, exactly as
``compute_control`` documents. Parameter values come from the bundled
``params/xl330/m6.json`` via ``bam.model.load_model`` so a package update cannot
silently desync this port from the training-side numbers.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Shipped defaults of the Dynamixel XL330-M288 firmware.
DEFAULT_KP_FW = 200.0
DEFAULT_VIN = 7.5
DEFAULT_MAX_PWM = 1.0
DEFAULT_MAX_CURRENT = 1.75


@dataclass
class BamParams:
    kt: float
    resistance: float
    error_gain: float
    kp_fw: float = DEFAULT_KP_FW
    vin: float = DEFAULT_VIN
    max_pwm: float = DEFAULT_MAX_PWM
    max_current: float | None = DEFAULT_MAX_CURRENT

    @property
    def duty_gain(self) -> float:
        return self.kp_fw * self.error_gain

    @property
    def stall_torque(self) -> float:
        return self.vin * self.kt / self.resistance

    def as_dict(self) -> dict[str, float | None]:
        return {
            "model": "xl330-m6",
            "kt": self.kt,
            "resistance": self.resistance,
            "errorGain": self.error_gain,
            "kpFirmware": self.kp_fw,
            "vin": self.vin,
            "maxPwm": self.max_pwm,
            "maxCurrent": self.max_current,
            "dutyGain": self.duty_gain,
            "stallTorqueNm": self.stall_torque,
        }


def load_bam_params(
    *,
    kp_fw: float = DEFAULT_KP_FW,
    vin: float = DEFAULT_VIN,
    max_current: float | None = DEFAULT_MAX_CURRENT,
) -> BamParams:
    """Load XL330 M6 parameters, overriding the two values the task config sets."""
    from bam.model import load_model

    motor = load_model(motor_name="xl330", model="m6")
    return BamParams(
        kt=float(motor.kt.value),
        resistance=float(motor.R.value),
        error_gain=float(motor.actuator.error_gain),
        kp_fw=float(kp_fw),
        vin=float(vin),
        max_current=max_current,
    )


def torque(
    params: BamParams,
    *,
    q_target: np.ndarray,
    q: np.ndarray,
    dq: np.ndarray,
) -> np.ndarray:
    """Joint torques for one control step (vectorised over the 14 servos)."""
    duty = (q_target - q) * params.duty_gain
    if params.max_current is not None:
        back_emf = params.kt * dq
        duty_span = params.resistance * params.max_current / params.vin
        duty_center = back_emf / params.vin
        duty = np.clip(duty, duty_center - duty_span, duty_center + duty_span)
    duty = np.clip(duty, -params.max_pwm, params.max_pwm)
    return (params.kt / params.resistance) * (duty * params.vin - params.kt * dq)
