import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).resolve().parents[1]/'evidence'
accuracy=json.loads((root/'accuracy.json').read_text())['results']
fig,axes=plt.subplots(1,2,figsize=(12,4.5),layout='constrained')
for mode,label in enumerate(['uniform','centripetal','chordal']):
 budgets=[128,512,2048,8192]
 values=[max(r['maxRelativeSpeedError'] for r in accuracy if r['parameterization']==mode and r['subdivisions']==b) for b in budgets]
 axes[0].loglog(budgets,values,marker='o',label=label)
axes[0].axhline(.005,color='red',linestyle='--',label='0.5% frozen limit')
axes[0].set(xlabel='Table subdivision budget',ylabel='Worst relative per-step arc error',title='Independent Simpson oracle / all fixtures')
axes[0].legend(fontsize=8);axes[0].grid(True,alpha=.25)
perf=json.loads((root/'performance.json').read_text())['results']
rows=[r for r in perf if r['label'].startswith('world-1000')]
labels=[f"{r['label'].split('-')[3]} path(s) / round {int(r['label'].split('-')[-1])+1}" for r in rows]
axes[1].barh(labels,[r['p95Ms'] for r in rows],color='#287b96',label='p95')
axes[1].barh(labels,[r['p50Ms'] for r in rows],color='#8acac0',label='p50')
axes[1].axvline(8,color='red',linestyle='--',label='8 ms frozen limit')
axes[1].set(xlabel='Wall milliseconds / complete World frame',title='1000 enabled followers / three independent Worlds')
axes[1].legend(fontsize=8);fig.savefig(root/'accuracy-performance.png',dpi=180)
