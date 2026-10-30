"""Build the portable Chinese workshop handout from the repository Markdown."""

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[3]


def build(report, out):
    report, out = Path(report).resolve(), Path(out).resolve()
    results = json.loads((report / "results.json").read_text())
    if [
        results["seedResults"][str(s)]["controllers"]["rl"]["recoverySuccesses"]
        for s in [7, 17, 27]
    ] != [28, 28, 22]:
        raise ValueError("handout claims require the matching published result")
    out.mkdir(parents=True, exist_ok=False)
    assets = out / "assets/originman"
    assets.mkdir(parents=True)
    for name in ["residual-recovery-poster.png", "workshop-flow.svg"]:
        shutil.copyfile(ROOT / "docs/assets/originman" / name, assets / name)
    for name in [
        "training",
        "final-conditions",
        "corrections",
        "ablations",
        "sensitivity",
    ]:
        shutil.copyfile(report / f"{name}.png", assets / f"residual-{name}.png")
    for name in ["recovery", "failure", "training-stages"]:
        shutil.copyfile(report / f"{name}.mp4", out / f"{name}.mp4")
        shutil.copyfile(report / f"{name}-poster.png", out / f"{name}-poster.png")
    for name in ["results.json", "report-evidence.json", "software-validation.json"]:
        shutil.copyfile(report / name, out / name)
    for p in (ROOT / "docs").glob("*originman*.md"):
        shutil.copyfile(p, out / p.name)
    source = ROOT / "docs/workshop-originman-basic.md"
    shutil.copyfile(
        Path(__file__).parent / "experiment-record.md", out / "experiment-record.md"
    )
    md = markdown.Markdown(extensions=["tables", "fenced_code", "toc"])
    body = md.convert(source.read_text())
    videos = """<section class="media" id="replays"><h2>直接看训练与前后效果</h2>
<p>四组对照使用同一扰动。失败回合终止后保持实际末帧。以下均为指定实验的物理回放。</p>
<h3>同扰动：基础反馈、未训练与训练后</h3><video controls preload="metadata" poster="recovery-poster.png" src="recovery.mp4"></video>
<h3>固定训练阶段：初始、10万、30万、最终</h3><video controls preload="metadata" poster="training-stages-poster.png" src="training-stages.mp4"></video>
<h3>保留一个训练后仍失败的条件</h3><video controls preload="metadata" poster="failure-poster.png" src="failure.mp4"></video></section>"""
    css = """*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f4f6f5;color:#1b3339;font:17px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}header{background:#143e45;color:#fff;padding:55px max(6vw,24px)}header h1{font-size:clamp(30px,4vw,48px);line-height:1.3;max-width:1000px}header p{max-width:900px;color:#d8ece9}.badge{display:inline-block;border:1px solid #82b5b5;border-radius:30px;padding:3px 14px;font-size:14px}header a{color:#f6d79b}.layout{display:grid;grid-template-columns:240px minmax(0,1040px);gap:35px;max-width:1380px;margin:35px auto;padding:0 24px}aside{position:sticky;top:20px;align-self:start;font-size:14px;max-height:90vh;overflow:auto}aside ul{list-style:none;padding-left:12px}aside li{margin:8px 0}aside a{color:#44676b;text-decoration:none}main{background:#fff;border:1px solid #e0e7e5;border-radius:16px;padding:36px;min-width:0}main>h1{display:none}h2{font-size:27px;line-height:1.4;margin-top:55px;padding-bottom:10px;border-bottom:2px solid #d6e9e5;scroll-margin-top:25px}h2:first-of-type{margin-top:15px}h3{font-size:20px;margin-top:32px}a{color:#11737c}strong{color:#164e55}img,video{display:block;width:100%;height:auto;border:1px solid #e0e7e5;border-radius:8px;margin:22px 0}video{background:#172327;max-height:78vh}table{display:block;overflow:auto;border-collapse:collapse;width:100%;font-size:15px;margin:24px 0}th{background:#e7f0ee}td,th{min-width:110px;padding:12px 14px;border:1px solid #d9e3e1;text-align:left;vertical-align:top}tr:nth-child(even){background:#f7faf9}pre{background:#182d33;color:#e4eeea;padding:20px;border-radius:9px;overflow:auto;font:13px/1.7 ui-monospace,monospace}code{font-family:ui-monospace,monospace}footer{padding:30px 24px;text-align:center;font-size:14px;color:#5d7378}.media{margin-top:45px}@media(max-width:980px){.layout{grid-template-columns:1fr}aside{position:static;max-height:none}aside>div>ul{columns:2}main{padding:22px}}@media print{body{background:white;font-size:11pt}header{padding:20px;background:white;color:#163a41}header p{color:#163a41}.layout{display:block;margin:0;padding:0}aside,video,.badge{display:none}main{border:0;padding:0}h2{break-after:avoid}img,tr,pre{break-inside:avoid}table{font-size:9pt}a{color:inherit}footer{display:none}}"""
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OriginMan 强化学习 Workshop｜4小时具体方案</title><style>{css}</style></head><body>
<header><span class="badge">4小时 · 仿真主线 · 已有RL效果证据</span><h1>同样推一下，<br>让强化学习帮助机器人恢复稳定</h1><p>OriginMan 基础 Workshop 实施方案。固定反馈打底，神经策略每20ms修正髋踝。课堂操作、训练记录、同条件对照和失败分析形成一条完整学习链。</p><p><a href="#replays">先看实际回放</a>　·　<a href="workshop-originman-basic.md">下载Markdown方案</a>　·　<a href="results.json">查看完整实验统计</a></p></header>
<div class="layout"><aside aria-label="目录">{md.toc}<p><a href="#replays">三段回放</a></p></aside><main>{body}{videos}</main></div><footer>实验结果已验证；整班彩排和真机迁移待完成。完整权重结果与学员现场训练分别记录。</footer></body></html>"""
    (out / "index.html").write_text(page)
    files = {
        str(p.relative_to(out)): {
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "bytes": p.stat().st_size,
        }
        for p in sorted(out.rglob("*"))
        if p.is_file()
    }
    (out / "handout-evidence.json").write_text(
        json.dumps(
            {
                "scope": "Portable workshop handout with copied published simulation evidence; not a fresh training or hardware result",
                "files": files,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.report, args.out)
