"""Plot all frozen policies and both non-RL baselines without selecting winners."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from experiment import SEEDS


def build(root):
    root = Path(root)
    report = json.loads((root / "extended-evaluation/evaluation.json").read_text())
    names = ["fixed-kick", "calibrated-interpolation"] + [
        f"ppo-seed-{s}" for s in SEEDS
    ]
    labels = [
        "Fixed kick",
        "Calibration + interpolation",
        "PPO seed 7",
        "PPO seed 17",
        "PPO seed 27",
    ]
    colors = ["#98a3b2", "#24619a", "#28786b", "#a86e25", "#8667ab"]
    fig, axes = plt.subplots(1, 3, figsize=(16, 4.8), layout="constrained")
    for name, label, color in zip(names, labels, colors, strict=True):
        rows = [
            r
            for r in report["cases"]
            if r["controller"] == name and r["condition"] == "nominal"
        ]
        axes[0].plot(
            [r["targetM"] * 100 for r in rows],
            [r["ballForwardM"] * 100 for r in rows],
            "-o",
            ms=3,
            label=label,
            color=color,
        )
    axes[0].plot([5, 21], [5, 21], "k--", lw=1, label="Perfect tracking")
    axes[0].set(
        xlabel="Held-out target displacement (cm)",
        ylabel="Actual forward displacement (cm)",
        title="Nominal fixed-ball distance tracking",
    )
    axes[0].legend(fontsize=7)
    axes[0].grid(alpha=0.2)
    values = [
        report["aggregate"][n]["all-conditions"]["meanDistanceErrorM"] * 100
        for n in names
    ]
    bars = axes[1].bar(labels, values, color=colors)
    axes[1].bar_label(bars, fmt="%.2f", padding=3)
    axes[1].tick_params(axis="x", labelrotation=22)
    axes[1].set(
        ylabel="Mean absolute distance error (cm)",
        title="60 paired scenarios per controller",
        ylim=(0, max(values) * 1.2),
    )
    axes[1].grid(axis="y", alpha=0.2)
    axes[1].set_axisbelow(True)
    for seed, color in zip(SEEDS, colors[2:], strict=True):
        curve = json.loads((root / f"seed-{seed}/training-summary.json").read_text())[
            "curve"
        ]
        axes[2].plot(
            [p["episodes"] for p in curve],
            [p["meanDistanceErrorM"] * 100 for p in curve],
            label=f"seed {seed}",
            color=color,
        )
    axes[2].set(
        xlabel="Physics episodes used by PPO",
        ylabel="Sampled training distance error (cm)",
        title="Training process (not test performance)",
    )
    axes[2].legend(fontsize=8)
    axes[2].grid(alpha=0.2)
    fig.suptitle(
        "OriginMan fixed-ball kick verification | frozen final policies | uncalibrated simulation",
        fontsize=13,
    )
    fig.savefig(root / "comparison.png", dpi=180)
    plt.close(fig)
    calibration = json.loads((root / "calibration.json").read_text())
    data = calibration["cases"]
    fig, ax = plt.subplots(figsize=(8, 5), layout="constrained")
    good = [
        r
        for r in data
        if not r["fallen"]
        and r["footBallContact"]
        and abs(r["ballLateralM"]) <= 0.05
        and r["finalTiltDegrees"] < 10
        and r["robotTranslationM"] < 0.05
    ]
    bad = [r for r in data if r not in good]
    sc = ax.scatter(
        [r["parameters"]["stroke"] * 1000 for r in good],
        [r["parameters"]["duration"] * 1000 for r in good],
        c=[r["ballForwardM"] * 100 for r in good],
        s=110,
        cmap="viridis",
        vmin=0,
        vmax=22,
    )
    ax.scatter(
        [r["parameters"]["stroke"] * 1000 for r in bad],
        [r["parameters"]["duration"] * 1000 for r in bad],
        marker="x",
        c="#ac4040",
        s=65,
        label="Miss / fall / invalid endpoint",
    )
    fig.colorbar(sc, ax=ax, label="Forward ball displacement (cm)")
    ax.set(
        xlabel="Swing-foot forward endpoint (mm)",
        ylabel="Forward-swing duration (ms)",
        title="63 calibration trials; red crosses are NOT successful kicks",
    )
    ax.legend(fontsize=8)
    fig.savefig(root / "calibration-map.png", dpi=180)
    plt.close(fig)
    md = [
        "# OriginMan 定点变力度踢球验证",
        "",
        "日期 2026年10月29日",
        "",
        "## 结论",
        "",
        "可以在当前全身仿真中，通过连续摆腿参数改变出球距离。PPO 也学出了目标距离到参数的映射。但与无 RL 的标定插值相比，没有出现稳定且明显的优势，不建议把该任务作为“RL 带来明显新增能力”的核心课程卖点。",
        "",
        "## 验证范围",
        "",
        "机器人自由底座、20 个受控关节，球是有质量和转动惯量的自由刚体。运动来自脚球接触，没有对球注入速度或给身体施加前进力。机器人不挪步找球，球的初始位置已知且固定；未验证机载摄像头定位。",
        "",
        "RL 每次踢球只输出两个连续参数：摆腿终点与前摆时长，再由相同参考轨迹转换为关节目标。算法是单步情境 MDP 上的 PPO，不是每 20ms 根据 IMU 决策的全关节闭环策略，也不是步态强化学习已完成。",
        "",
        "## 对照方法",
        "",
        "- 固定踢法：所有目标使用同一组稳定参数。该轨迹由本次仿真构建，不是已标定的厂家原始踢球动作组。",
        "- 标定插值：扫描 63 组参数，使用慢速稳定动作中的 5 个标定点，按目标距离插值。没有使用测试结果挑参数。",
        "- PPO：3 个独立训练种子，各 384 个真实物理回合；每个回合结束后用距离、方向、接触和站稳奖励更新参数策略。无教师标签。",
        "",
        "训练目标为出球前向位移 5、9、13、17 cm。最初测试 7、11、15、19 cm；随后固定最终策略不再训练，扩展为 12 个未训练距离：6、7、8、10、11、12、14、15、16、18、19、20 cm。",
        "",
        "每个测试距离覆盖 5 个条件：标称物理、滚动摩擦减小 20%、增大 20%、球前移 3mm、球侧移 3mm。总计每种控制器 60 个确定性配对场景；这是场景覆盖，不是 60 次独立随机真机试验。",
        "",
        "## 更密测试的完整结果",
        "",
        "|控制器|标称平均距离误差 cm|标称达标|全部条件平均误差 cm|全部条件达标|",
        "|---|---:|---:|---:|---:|",
    ]
    for n, label in zip(names, labels, strict=True):
        a = report["aggregate"][n]
        nom = a["nominal"]
        allc = a["all-conditions"]
        md.append(
            f"|{label}|{nom['meanDistanceErrorM'] * 100:.2f}|{round(nom['successRate'] * nom['episodes'])}/{nom['episodes']}|{allc['meanDistanceErrorM'] * 100:.2f}|{round(allc['successRate'] * allc['episodes'])}/{allc['episodes']}|"
        )
    md += [
        "",
        "达标要求同时满足：距离误差不超过 2.5cm、踢脚实际碰球、没有其他身体部位撞球、全程未跌倒、球侧偏不超过 5cm、最终身体倾斜小于 10°、身体平移小于 5cm、球已基本停下。所有最终测试的有效动作比例均为 100%；距离达标与“碰到球且站稳”分开统计。",
        "",
        "![所有策略的完整对照](comparison.png)",
        "",
        "最初仅 4 个标称测试距离时，一部分 PPO 结果看似更好；扩展测试后，标称条件下插值方法的平均误差反而低于三个 PPO 结果。因此保留两轮报告，不用最初的小样本结论代替扩大后的结果。变化条件下只有一个种子的平均误差略有改善，未形成稳定的跨种子优势。",
        "",
        "## 视频与过程记录",
        "",
        "[三组并排对照视频](kick-comparison.mp4)",
        "",
        "视频展示固定踢法、标定插值、PPO 种子 7。目标取最初预先确定测试集的第一个和最后一个距离，即 7cm 和 19cm；不按表现选择种子或案例。橙色区域表示目标前向位移带，不代表球门。",
        "",
        "[原始 4 距离测试](evaluation.json) · [扩展测试全部逐例结果](extended-evaluation/evaluation.json) · [63 次参数标定](calibration.json)",
        "",
        "每个 seed 目录保留：experiment.json、逐回合 episodes.jsonl、每轮 telemetry.jsonl、权重检查点、采样关节和球轨迹、最终 policy.pt 与 policy.onnx、导出一致性误差、训练时源码快照。来源模型和场景指纹与参数范围写入实验说明。",
        "",
        "![参数扫描与失败区域](calibration-map.png)",
        "",
        "## 解释与限制",
        "",
        "“近远变化”确实可见，但插值方法同样能完成，不能把这个视觉差异全部算作 RL 的独有收益。PPO 使用的物理样本也多于非 RL 标定。该实验适合说明奖励学习和基线比较，不足以证明 RL 必要或更省调参成本。",
        "",
        "球的质量、半径、摩擦、位置伺服和碰撞几何均为仿真假设。关闭了机器人自碰撞；未验证装机限位、舵机时序、视觉或真机接触。摩擦没有作为策略观测输入，结果不能解读为策略识别摩擦后主动补偿。",
        "",
        "待厂家确认：模型与样机对应、关节方向与限位、控制固件语义、执行器响应。待真机验证：已知球位的可达性与视野、位置回读及控制时序、脚球接触和姿态恢复。此实验不改变所有策略“不可直接部署”的状态。",
    ]
    (root / "RESULTS.md").write_text("\n".join(md) + "\n")
    print(root / "RESULTS.md")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    a = p.parse_args()
    build(a.root)
