"""Offline visual report of frozen conventional feedback vs frozen residual RL."""

import argparse
import base64
import gzip
import html
import json
import os
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import ListedColormap
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engines/originman-straight"))
from monitor import write_json
from standing_render import render

LABELS = {
    "original": "原踝部 PD", "ankle-pd": "重新调参踝部 PD",
    "hip-ankle-pd": "髋踝联合 PD", "joint-feedback": "髋踝及关节状态反馈",
    "rl-7": "原基础＋RL 种子7", "rl-17": "原基础＋RL 种子17", "rl-27": "原基础＋RL 种子27",
}


def read(p):
    return json.loads(p.read_text())


def lines(p):
    if p.suffix == ".gz":
        with gzip.open(p, "rt") as f:
            return [json.loads(s) for s in f]
    return [json.loads(s) for s in p.read_text().splitlines()]


def report(root, tuning, evaluation, out, font, video):
    out.mkdir(parents=True, exist_ok=False)
    font_manager.fontManager.addfont(font)
    plt.rcParams["font.family"] = font_manager.FontProperties(fname=font).get_name()
    plt.rcParams["axes.unicode_minus"] = False
    frozen = read(tuning / "frozen-feedback.json")
    summary = read(evaluation / "summary.json")
    plan = read(evaluation / "plan.json")
    rows = lines(evaluation / "episodes.jsonl.gz")
    trials = lines(tuning / "tuning-trials.jsonl")
    chosen = summary["selectedFeedbackFamily"]
    modes = list(LABELS)
    suites = ["historical", "new-fixed"]
    titles = {"historical": "原公开条件 31项", "new-fixed": "本轮新增固定条件 31项"}
    colors = ["#a9b4bd", "#6f9db7", "#439b85", "#2c6656", "#9561ac", "#bd7f39", "#a94451"]
    fig, axes = plt.subplots(1, 2, figsize=(15, 5.4), layout="constrained")
    for ax, suite in zip(axes, suites):
        values = [summary["suites"][suite][m]["recovered"] for m in modes]
        ax.barh([LABELS[m] + (" ★验证集选定" if m == chosen else "") for m in modes], values, color=colors)
        ax.invert_yaxis()
        ax.set_xlim(0, 34)
        for i, n in enumerate(values):
            ax.text(n+.3, i, f"{n}/31", va="center", fontsize=11)
        ax.set_title(titles[suite])
        ax.set_xlabel("满足完整恢复判据的条件数")
        ax.grid(axis="x", alpha=.2)
        ax.set_axisbelow(True)
    fig.suptitle("同模型、同扰动、同执行限制；最终权重与传统参数均冻结", fontsize=15)
    fig.savefig(out / "coverage.png", dpi=160)
    plt.close(fig)
    fig, axes = plt.subplots(2, 1, figsize=(16, 7.2), layout="constrained")
    for ax, suite in zip(axes, suites):
        matrix = []
        for mode in modes:
            group = [r for r in rows if r["suite"] == suite and r["controller"] == mode]
            matrix.append([2 if r["recoverySuccess"] else 0 if r["fallen"] else 1 for r in group])
        ax.imshow(matrix, cmap=ListedColormap(["#b74646", "#e4ae48", "#278571"]), vmin=0, vmax=2, aspect="auto")
        ax.set_yticks(range(len(modes)), [LABELS[m] for m in modes])
        ax.set_xticks(range(31), range(31), fontsize=8)
        ax.set_title(titles[suite] + "   绿＝恢复  黄＝未恢复但未倒  红＝跌倒")
        ax.set_xlabel("固定条件编号；第30项为无扰动")
    fig.savefig(out / "all-conditions.png", dpi=160)
    plt.close(fig)
    fig, axes = plt.subplots(1, 2, figsize=(14, 4.5), layout="constrained")
    best = np.maximum.accumulate([r["score"][1] if r["score"][0] else 0 for r in trials])
    axes[0].scatter(range(1, len(trials)+1), [r["score"][1] for r in trials], s=8, alpha=.35, color="#427c8c", label="每组参数的调参集恢复数")
    axes[0].plot(range(1,len(best)+1), best, color="#283e4b", label="保留正常站立的累计最佳")
    axes[0].set(xlabel="候选参数编号", ylabel="调参条件恢复数 / 13", ylim=(-.5,13.7), title="传统反馈搜索全过程")
    axes[0].legend(fontsize=8)
    validation = read(tuning / "validation-results.json")
    for family, color in zip(modes[:4], colors[:4]):
        group = [r for r in validation if r["family"] == family]
        axes[1].scatter([r["score"][1] for r in group], [r["id"] for r in group], label=LABELS[family], s=25, color=color)
    axes[1].set(xlabel="验证集恢复数 / 13", ylabel="候选参数编号", xlim=(-.5,13.7), title="仅按验证集冻结最终传统反馈")
    axes[1].legend(fontsize=8)
    fig.savefig(out / "tuning.png", dpi=150)
    plt.close(fig)

    by_key = {(r["suite"],r["caseIndex"],r["controller"]):r for r in rows}
    differences = [i for i in range(31) if by_key[("historical",i,chosen)]["recoverySuccess"] != by_key[("historical",i,"rl-7")]["recoverySuccess"]]
    case_index = differences[0] if differences else 0
    pair_modes = ["original", chosen, "rl-7", "rl-27"]
    if chosen == "original":
        pair_modes[1] = "hip-ankle-pd"
    paired = []
    for mode in pair_modes:
        row = dict(by_key[("historical",case_index,mode)])
        row["displayLabel"] = LABELS[mode]
        row["originalCaseIndex"] = case_index
        paired.append(row)
    case = paired[0]
    fig, ax = plt.subplots(figsize=(12,4.6),layout="constrained")
    for row, color in zip(paired,["#89959e","#278571","#9561ac","#a94451"]):
        ax.plot([f["time"] for f in row["frames"]],[f["tiltDegrees"] for f in row["frames"]],label=LABELS[row["controller"]],color=color)
    ax.axvspan(case["start"],case["start"]+.2,color="#d5bc67",alpha=.25)
    ax.axhline(5, color="gray",ls="--",lw=.8,label="最终恢复倾角上限 5°（还需同时满足其他条件）")
    ax.set(xlabel="仿真时间 / 秒", ylabel="身体倾角 / 度",title=f"原条件 {case_index}：{case['force']:+g} N，{case['start']:g} s 开始；首个结果不一致条件")
    ax.legend(fontsize=9)
    ax.grid(alpha=.2)
    fig.savefig(out/"paired-tilt.png",dpi=160)
    plt.close(fig)
    paired_dir=out/"paired-records"
    paired_dir.mkdir()
    (paired_dir/"episodes.jsonl").write_text("".join(json.dumps(r,allow_nan=False)+"\n" for r in paired))
    video_files=[]
    if video:
        render(root/"standing-residual-seed7/model/scene.xml",paired_dir,out/"comparison.mp4",0,font)
        video_files.append("comparison.mp4")
        reverse = next((i for i in range(31) if by_key[("historical",i,"rl-7")]["recoverySuccess"] and not by_key[("historical",i,chosen)]["recoverySuccess"]),None)
        if reverse is not None and reverse != case_index:
            opposite=out/"rl-gain-records"
            opposite.mkdir()
            other=[]
            for mode in pair_modes:
                row=dict(by_key[("historical",reverse,mode)])
                row.update(displayLabel=LABELS[mode],originalCaseIndex=reverse)
                other.append(row)
            (opposite/"episodes.jsonl").write_text("".join(json.dumps(r,allow_nan=False)+"\n" for r in other))
            render(root/"standing-residual-seed7/model/scene.xml",opposite,out/"rl-gain.mp4",0,font)
            video_files.append("rl-gain.mp4")

    def embed(name):
        return "data:image/png;base64,"+base64.b64encode((out/name).read_bytes()).decode()

    compact=[]
    for row in rows:
        compact.append({**{k:v for k,v in row.items() if k!="frames"},"trace":[[f["time"],f["tiltDegrees"]] for f in row["frames"]]})
    table="".join(f"<tr><th>{html.escape(LABELS[m])}{' ★选定' if m==chosen else ''}</th>"+"".join(f"<td>{summary['suites'][s][m]['recovered']}/31</td><td>{summary['suites'][s][m]['falls']}</td>" for s in suites)+"</tr>" for m in modes)
    details="".join(f"<tr><th>{html.escape(LABELS[f])}</th><td>{', '.join(f'{n:.5g}' for n in r['coefficients'])}</td><td>{r['score'][1]}/13</td></tr>" for f,r in frozen["families"].items())
    selected_n=[summary['suites'][s][chosen]['recovered'] for s in suites]
    rl_n=[[summary['suites'][s][f'rl-{seed}']['recovered'] for seed in [7,17,27]] for s in suites]
    delta=[[v-selected_n[j] for v in rl_n[j]] for j in range(2)]
    envelope=[sum(any(by_key[(s,i,m)]["recoverySuccess"] for m in modes[:4]) for i in range(31)) for s in suites]
    conclusion=f"验证集选定的传统反馈为{LABELS[chosen]}，原31项恢复{selected_n[0]}项，新增31项恢复{selected_n[1]}项。RL种子7、17、27分别为原条件{'、'.join(map(str,rl_n[0]))}项、新条件{'、'.join(map(str,rl_n[1]))}项。"
    if all(selected_n[j]>=max(rl_n[j]) for j in [0,1]):
        verdict="强化学习的整体覆盖优势未保留。此前对原踝部PD的提升，不能继续作为优于合理调参传统反馈的证据。"
    elif all(min(delta[j])>=6 for j in [0,1]):
        verdict="三个强化学习种子均保留净增至少6项的覆盖优势；该结论限于本轮声明的传统反馈族和搜索预算。"
    elif all(min(rl_n[j])>selected_n[j] for j in [0,1]):
        verdict="强化学习仍有覆盖收益，但并非所有种子都达到净增至少6项的明显收益门槛，不能承诺每次训练都有明显优势。"
    else:
        verdict="结果存在种子或条件依赖，不能宣称强化学习稳定优于调参后的传统反馈。"
    payload={"conclusion":conclusion,"verdict":verdict,"selectedFeedbackFamily":chosen,"netRecoveryGains":dict(zip(suites,delta)),"diagnosticNonRlUnionCoverage":dict(zip(suites,envelope)),"videoCase":case_index,"videos":video_files,"summary":summary,"tuningCandidates":len(trials),"hardwareEligible":False}
    write_json(out/"results.json",payload)
    content='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OriginMan 传统反馈与 RL 同条件对比</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f3f6f7;color:#20323a;font-family:system-ui,sans-serif;line-height:1.7}main{max-width:1180px;margin:auto;padding:32px 24px 80px}h1{font-size:30px;line-height:1.35}h2{font-size:22px;margin-top:36px}p{max-width:100ch}section{background:white;padding:24px;border-radius:10px;margin:18px 0;border:1px solid #dce4e7}img,video{display:block;width:100%;height:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #dce4e7}thead{background:#edf3f4}.note{color:#53666f;font-size:14px}.verdict{font-weight:700;font-size:21px}select{font:inherit;padding:6px;margin:5px 8px 5px 0;max-width:100%}canvas{width:100%;height:340px;border:1px solid #e4eaec;margin:15px 0}.scroll{overflow:auto}code{word-break:break-all}a{color:#176b82}</style><main>
    <p class="note">OriginMan Workshop · 传统基线补充验收 · 仅仿真</p><h1>传统反馈合理调参后<br>RL 的优势还在吗</h1><section><p class="verdict">VERDICT</p><p>CONCLUSION</p><p>先用独立调参集搜索，再按独立验证集冻结传统参数；最后运行原公开31项和本轮新增31项。强化学习沿用三个种子的最终权重及原基础控制，不重新训练，也不把新反馈直接塞进旧策略。</p><p class="note">新增条件未用于本轮传统参数选择；任务、模型及原公开条件已有历史开发，不能据此宣称整个研究是盲测。无真机证据。</p><img src="COVERAGE" alt="全部控制器在两个条件集上的恢复数"><div class="scroll"><table><thead><tr><th>控制器</th><th>原条件恢复</th><th>跌倒</th><th>新条件恢复</th><th>跌倒</th></tr></thead><tbody>TABLE</tbody></table></div></section>
    <section><h2>传统控制器获得了什么机会</h2><p>CANDIDATES组候选，每组13项调参条件；每族最多8组进入另外13项验证条件，共25组。包括踝部PD、髋踝联合PD、髋踝及关节位置速度反馈。第一轮413组结构网格、Sobol覆盖和局部细化之后，追加有独立记录的差分进化优化，髋踝P、D均允许正负方向。追加搜索仍未查看最终评测结果。恢复数优先，随后比较跌倒、最终稳定比例与倾角；正常无扰动站立必须保留。</p><p>使用本体侧倾角、角速度、髋踝关节位置与速度。传统反馈和RL均不读取推力、施力时刻或世界位置。两者共用相同的参考站姿、0.3rad总修正幅度、每20ms最多0.075rad目标变化以及相同关节、伺服和力矩限制。</p><img src="TUNING" alt="传统控制器完整调参过程"><p class="note">下表系数依次为踝P、踝D、髋P、髋D、踝位置、踝速度、髋位置、髋速度。特征使用rad与rad/s。结果不意味着这些是所有传统控制方法的最优参数。</p><div class="scroll"><table><thead><tr><th>控制器</th><th>冻结系数</th><th>验证恢复</th></tr></thead><tbody>DETAILS</tbody></table></div></section>
    <section><h2>全部条件与失败</h2><img src="MATRIX" alt="两个条件集的全部结果"><p>恢复要求6秒内不倒，最后1秒至少90%的控制步同时满足：倾角≤5°、角速度≤0.3rad/s、平面速度≤0.05m/s、高度≥初始85%、平面位移≤12cm、双脚接触。只站着没有倒不算恢复。</p><label>条件集 <select id="suite"><option value="historical">原公开31项</option><option value="new-fixed">新增固定31项</option></select></label><label>条件 <select id="case"></select></label><label>第一组 <select id="a"></select></label><label>第二组 <select id="b"></select></label><canvas id="chart"></canvas><p id="case-info"></p><div class="scroll"><table><thead><tr><th>控制器</th><th>结果</th><th>峰值倾角</th><th>最终倾角</th><th>最终稳定比例</th><th>仿真时长</th></tr></thead><tbody id="case-table"></tbody></table></div><p class="note">曲线在真实回合终止处结束，不补画跌倒后轨迹。相同结果也可能有不同恢复质量。</p></section>
    <section><h2>按预先声明规则选择的回放</h2><p>原公开条件中，选定传统反馈与RL种子7结果首次不一致的编号；如有相反方向的差异，另外提供一段回放。完整条件图与数据同时保留，不能用单段视频代表整体。</p><img src="PAIRED" alt="选定条件的身体倾角">VIDEOS</section>
    <section><h2>溯源与课程结论</h2><p>VERDICT</p><p>本轮只回答传统反馈调参后的仿真对照。真机仍需测量执行器响应、IMU延迟、脚底接触和实际控制周期。无论本轮结果如何，都不据此承诺真机可部署或真机效果。</p><p>参数计划、全部调参记录、验证结果、冻结参数、两组完整评测及源码模型摘要均保存在本次独立实验目录。评测前后检查模型、源文件和三个RL制品未变化。</p><p><a href="results.json">报告摘要 JSON</a> · <a href="../tuning/frozen-feedback.json">冻结传统反馈</a> · <a href="../tuning/tuning-plan.json">调参计划</a> · <a href="../evaluation/plan.json">评测计划</a> · <a href="../evaluation/summary.json">完整汇总</a> · <a href="../evaluation/episodes.jsonl">完整轨迹 JSONL</a></p></section></main><script>
    const data=DATA,labels=LABELDATA,selected=SELECTED;
    const $=id=>document.getElementById(id);const modes=Object.keys(labels);
    for(let i=0;i<31;i++)$('case').add(new Option(i,i));for(const id of ['a','b'])for(const m of modes)$(id).add(new Option(labels[m],m));$('a').value=selected;$('b').value='rl-7';$('case').value=CASE;
    function draw(){const suite=$('suite').value,index=+$('case').value,rows=data.filter(r=>r.suite===suite&&r.caseIndex===index);const r0=rows[0];$('case-info').textContent=`条件 ${index}：侧推 ${r0.force} N，${r0.start} s开始，持续0.2 s。`;$('case-table').innerHTML=rows.map(r=>`<tr><th>${labels[r.controller]}</th><td>${r.recoverySuccess?'恢复':r.fallen?'跌倒':'未倒但未恢复'}</td><td>${r.peakTiltDegrees.toFixed(2)}°</td><td>${r.finalTiltDegrees.toFixed(2)}°</td><td>${(r.settledFraction*100).toFixed(0)}%</td><td>${r.seconds.toFixed(2)} s</td></tr>`).join('');const c=$('chart'),dpr=window.devicePixelRatio||1,w=c.clientWidth,h=340;c.width=w*dpr;c.height=h*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);const chosen=[$('a').value,$('b').value].map(m=>rows.find(r=>r.controller===m)),ymax=Math.max(10,...chosen.map(r=>r.peakTiltDegrees))*1.1,L=55,R=20,T=48,B=36;const x=t=>L+t/6*(w-L-R),y=v=>h-B-v/ymax*(h-B-T);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.font='13px system-ui';ctx.fillStyle='#faf0d3';ctx.fillRect(x(r0.start),T,x(r0.start+.2)-x(r0.start),h-B-T);for(let i=0;i<=5;i++){const v=ymax*i/5;ctx.strokeStyle='#e2e8eb';ctx.beginPath();ctx.moveTo(L,y(v));ctx.lineTo(w-R,y(v));ctx.stroke();ctx.fillStyle='#53666f';ctx.fillText(v.toFixed(1),8,y(v)+4)}for(let i=0;i<=6;i++){ctx.fillText(i+'s',x(i)-7,h-12)}ctx.fillText('倾角 / 度',L,T-15);chosen.forEach((r,i)=>{ctx.strokeStyle=i?'#9561ac':'#278571';ctx.lineWidth=2;ctx.beginPath();r.trace.forEach(([t,v],j)=>j?ctx.lineTo(x(t),y(v)):ctx.moveTo(x(t),y(v)));ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText(labels[r.controller],L+100+i*260,24)})}
    for(const id of ['suite','case','a','b'])$(id).addEventListener('change',draw);window.addEventListener('resize',draw);draw();</script></html>'''
    replacements={"CANDIDATES":str(len(trials)),"VERDICT":html.escape(verdict),"CONCLUSION":html.escape(conclusion),"COVERAGE":embed("coverage.png"),"TUNING":embed("tuning.png"),"MATRIX":embed("all-conditions.png"),"PAIRED":embed("paired-tilt.png"),"TABLE":table,"DETAILS":details,"VIDEOS":"".join(f'<video controls preload="metadata" src="{name}"></video>' for name in video_files),"LABELDATA":json.dumps(LABELS,ensure_ascii=False),"SELECTED":json.dumps(chosen),"CASE":str(case_index),"DATA":json.dumps(compact,ensure_ascii=False,allow_nan=False)}
    # Replace long tokens before DATA, which is a suffix of LABELDATA.
    for key in sorted(replacements,key=len,reverse=True):
        content=content.replace(key,replacements[key])
    original_stats=summary['suites']['historical']['original']
    tuned_stats=summary['suites']['historical'][chosen]
    improved=len(original_stats['lossIndicesVsSelectedFeedback'])
    regressed=len(original_stats['gainIndicesVsSelectedFeedback'])
    unsettled=tuned_stats['cases']-tuned_stats['recovered']-tuned_stats['falls']
    additional = f'<p><strong>收益幅度：</strong>相对验证集选定的传统反馈，RL种子7、17、27在原条件分别净增{"、".join(map(str,delta[0]))}项，在新增条件分别净增{"、".join(map(str,delta[1]))}项。课程原定覆盖门槛为净增至少6项；逐个种子判断，不用最好的种子代替所有结果。</p><p>调参后的传统反馈在原条件中，相比原踝部PD改善{improved}项、退化{regressed}项；跌倒从{original_stats["falls"]}项减少到{tuned_stats["falls"]}项，另外{unsettled}项未倒但未达到完整恢复。它并非逐条件更优，因此原控制器和调参后的各族结果全部保留。即使把四个非RL候选的成功条件合并，原条件覆盖{envelope[0]}/31、新条件覆盖{envelope[1]}/31；这个合并使用事后结果，只是诊断，不是可部署的单个控制器。</p>'
    content = content.replace('<div class="scroll"><table><thead><tr><th>控制器</th><th>原条件恢复', additional+'<div class="scroll"><table><thead><tr><th>控制器</th><th>原条件恢复',1)
    content = content.replace("../tuning/", html.escape(os.path.relpath(tuning, out)) + "/")
    content = content.replace("../evaluation/", html.escape(os.path.relpath(evaluation, out)) + "/")
    content = content.replace('episodes.jsonl">完整轨迹', 'episodes.jsonl.gz">完整轨迹')
    unique=len({tuple(r['coefficients']) for r in trials})
    content = content.replace('CANDIDATES组候选', 'CANDIDATES次候选参数评估')
    content = content.replace(f'{len(trials)}组候选', f'{len(trials)}次候选参数评估（{unique}组不同参数，保留重复评估）')
    content = content.replace('共25组。包括', '最终一轮共25组；前轮25组验证另行保留。包括')
    content = content.replace('结果不意味着这些是所有传统控制方法的最优参数。', '调参集最佳9/13，最终验证集各族均为5/13，表明搜索结果有泛化限制。这里尚未覆盖增益调度、积分控制、LQR或MPC，不能据此认定传统控制已达最优，或RL不可替代。')
    (out/"index.html").write_text(content)
    print(json.dumps(payload,ensure_ascii=False,indent=2))


if __name__=="__main__":
    p=argparse.ArgumentParser()
    for arg in ["root","tuning","evaluation","out"]:
        p.add_argument("--"+arg,type=Path,required=True)
    p.add_argument("--font",required=True)
    p.add_argument("--video",action="store_true")
    a=p.parse_args()
    report(a.root,a.tuning,a.evaluation,a.out,a.font,a.video)
