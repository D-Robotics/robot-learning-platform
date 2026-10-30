"""Aggregate every registered run, including failed reward experiments."""

import argparse
import json
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def build(root):
    root = Path(root)
    experiments = [
        ("seed 7", "eval-seed7"),
        ("seed 17", "eval-legacy-seed17"),
        ("seed 27", "eval-legacy-seed27"),
        ("reward v2 seed 17", "eval-straight-seed17"),
    ]
    reports = [
        json.loads((root / name / "eval-report.json").read_text())
        for _, name in experiments
    ]
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.8), layout="constrained")
    labels = [n for n, _ in experiments]
    x = np.arange(len(labels))
    w = 0.35
    for ax, key, scale, label in zip(
        axes,
        ["lateralAbsMeters", "forwardMeters", "headingAbsRadians"],
        [100, 100, 180 / np.pi],
        [
            "Endpoint lateral error (cm), lower is better",
            "Forward distance (cm), retain progress",
            "Endpoint heading error (degrees)",
        ],
    ):
        base = [r["aggregate"]["reference"][key] * scale for r in reports]
        rl = [r["aggregate"]["rl"][key] * scale for r in reports]
        bars = ax.bar(x - w / 2, base, w, label="Reference", color="#8d99ae")
        others = ax.bar(x + w / 2, rl, w, label="Reference + PPO", color="#24766d")
        ax.bar_label(bars, fmt="%.2f", fontsize=8, padding=3)
        ax.bar_label(others, fmt="%.2f", fontsize=8, padding=3)
        ax.set_xticks(x, labels, rotation=18, ha="right")
        ax.set_title(label, fontsize=10)
        ax.set_ylim(0, max(base + rl) * 1.2)
        ax.grid(axis="y", alpha=0.2)
        ax.set_axisbelow(True)
    axes[0].legend(fontsize=8)
    fig.suptitle(
        "OriginMan free-base MuJoCo | 30 paired cases per policy | 8 seconds\nNo root assistance | all runs shown | simulation parameters uncalibrated",
        fontsize=12,
    )
    fig.savefig(root / "rl-comparison.png", dpi=180)
    plt.close(fig)
    agg = []
    for (name, _), r in zip(experiments, reports):
        agg.append(
            {
                "experiment": name,
                "baseline": r["aggregate"]["reference"],
                "rl": r["aggregate"]["rl"],
                "progressRetention": r["forwardProgressRetention"],
                "pairedImprovementCi95Meters": r["pairedLateralImprovementCi95Meters"],
                "benefitEstablished": r["demonstratesCorrectionWithoutSlowing"],
            }
        )
    result = {
        "experiments": agg,
        "threeSeedMean": {
            k: float(np.mean([r["aggregate"]["rl"][k] for r in reports[:3]]))
            for k in ["lateralAbsMeters", "forwardMeters", "headingAbsRadians"]
        },
        "conclusion": "Training/evaluation pipeline works. Robust, visually obvious correction benefit without slowing has NOT been established.",
        "hardwareEligible": False,
    }
    (root / "comparison-summary.json").write_text(json.dumps(result, indent=2))
    md = [
        "# OriginMan 直行残差仿真首轮结果",
        "",
        "模型适配、参考迈步、PPO 训练、ONNX 推理及配对评测已跑通。当前未证明稳定且肉眼明显的纠偏收益，也未做真机验证。",
        "",
        "## 相同预算的三个训练种子",
        "",
        "每个策略均以相同的 30 个初态配对测试，单回合 8 秒。左右腿伺服增益差异为 −18%、−9%、0、9%、18%；初始偏航由固定评测种子产生。训练差异范围为 ±20%，测试属于同分布新初态，不是分布外鲁棒性证明。",
        "",
        "|策略|平均终点侧偏 cm|平均前进 cm|终点航向绝对误差 度|跌倒次数|",
        "|---|---:|---:|---:|---:|",
    ]
    b = reports[0]["aggregate"]["reference"]
    md.append(
        f"|参考步态|{b['lateralAbsMeters'] * 100:.2f}|{b['forwardMeters'] * 100:.2f}|{np.degrees(b['headingAbsRadians']):.2f}|0/30|"
    )
    for (name, _), r in zip(experiments, reports):
        q = r["aggregate"]["rl"]
        md.append(
            f"|{name}|{q['lateralAbsMeters'] * 100:.2f}|{q['forwardMeters'] * 100:.2f}|{np.degrees(q['headingAbsRadians']):.2f}|{round(q['fallen'] * 30)}/30|"
        )
    md += [
        "",
        "前 3 个 RL 结果均训练 120 × 8 × 128 = 122,880 个控制步；奖励 v2 实验训练 300 × 8 × 128 = 307,200 步。所有训练均为真实 PPO 更新，无教师行为标签。两组均有双脚交替单支撑证据。奖励 v2 是单独参数试验，不能与前三项混为同一算法预算。",
        "",
        "三个种子中两个侧偏改善、一个退化；改善的两组前进距离也减少约 9% 至 10%。奖励 v2 退化明显。当前没有一组通过“配对改善置信区间为正且保留至少 95% 前进距离”的探索性检查。这个检查不是实机部署或课程交付门禁。",
        "",
        "![全部试验对照](rl-comparison.png)",
        "",
        "[第一训练种子第一个固定评测案例视频](comparison-seed7-case0.mp4)",
        "",
        "视频选择规则为首个训练种子、首个评测案例，不按效果选择。图表包含全部试验。视频与百分比不能替代逐例报告；报告保留每个策略的 SHA256、逐例侧偏、前进、支撑状态和条件。",
        "",
        "## 模型与真实性边界",
        "",
        "使用用户提供模型的 20 个转动关节、原有连杆变换和质量惯量，总质量约 1.9923891 kg；底座自由，运动来自关节执行器与地面反力，没有身体焊接、外加前进力或位置瞬移。参考轨迹由原模型运动学和双腿 IK 构建，不是已经验证的原厂步态映射。",
        "",
        "简化条件：逐连杆 STL 包围盒碰撞、关闭自碰撞、假定的位置伺服参数及摩擦、理想仿真姿态与关节状态。航向和投影重力直接来自仿真姿态，板端姿态估计及漂移尚未实现。物理步长 2 ms、控制周期 20 ms 是仿真假设，不是控制板实测能力。",
        "",
        "## 需要厂家确认",
        "",
        "- 模型包对应的机械版本和实际电池、相机等配置。",
        "- URDF 关节与舵机 ID、安装正方向、零位及装机安全限位的对应。",
        "- 连续目标覆盖或排队、插值、停止、掉线与回读调度的固件语义。",
        "- 实机舵机型号及 IMU 安装坐标、量程和上报配置。已有响应记录或仿真工程可提供入口；不是从零交付要求。",
        "",
        "## 待真机验证",
        "",
        "- 逐关节小幅运动，核对方向、零位、限位和回读。",
        "- 全腿读写与 IMU 并行的频率、延迟、抖动、丢包和数据年龄。",
        "- 负载下的位置跟踪、回差、死区、力矩限制及电压影响。",
        "- 姿态估计与航向漂移、策略循环耗时及异常退出。",
        "- 保护条件下站立、参考迈步、RL 对照，再验证起停与人体跟随。",
        "",
        "## 下一步",
        "",
        "优先减少策略修正自由度并明确“保持前进的纠偏”目标；保留现有参考步态作为固定对照。扩大到更多训练种子和更长评测前，应先让同预算小试验稳定改善。当前不新增转向、人体感知或真机控制范围。",
        "",
        "## 已复用的基建",
        "",
        "ActorCritic 网络来自现有 microduck-football；置信区间函数来自 microduck-eval。新增引擎使用原 local-training-worker 的请求、日志、产物 SHA256SUMS 和结果协议。Worker 冒烟单独保存，不与上述训练质量数据混用；全部制品 deployable=false。",
    ]
    (root / "RESULTS.md").write_text("\n".join(md) + "\n")
    print(root / "RESULTS.md")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    a = p.parse_args()
    build(a.root)
