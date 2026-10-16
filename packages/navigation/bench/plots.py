"""Plot actual JSON evidence; no simulation or image reconstruction."""
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon,Circle,Rectangle
ROOT=Path(__file__).resolve().parents[3]/'artifacts/roi-navigation'
OUT=ROOT/'images';OUT.mkdir(exist_ok=True)
def load(name):return json.loads((ROOT/name).read_text())
def surface(ax,asset):
    vertices=np.array(asset['vertices']).reshape(-1,3)
    for p in asset['polygons']:ax.add_patch(Polygon(vertices[p][:,[0,2]],color='#77c9ba',alpha=.35,ec='#377f77',lw=.4))
    ax.set_aspect('equal');ax.set_xlabel('World X (m)');ax.set_ylabel('World Z (m)');ax.grid(alpha=.15)
def trajectories(ax,r):
    surface(ax,r['asset']); poses=np.array([s['positions'] for s in r['trajectories']]);
    for i,start in enumerate(r['starts']):
        color=plt.cm.tab20(i%20);ax.plot(poses[:,i,0],poses[:,i,2],color=color,lw=1.2);ax.add_patch(Circle(start,.3,ec=color,fill=False));ax.scatter(*start,c=[color],s=18);ax.scatter(r['destinations'][i][0],r['destinations'][i][2],marker='x',c=[color],s=30)
    ax.set_xlim(-6,6);ax.set_ylim(-5,5)
def save(fig,name):fig.tight_layout();fig.savefig(OUT/name,dpi=160);plt.close(fig)
queue=load('effect-door-single-file.json');stress=load('effects.json')['cases'][2]
fig,axs=plt.subplots(1,2,figsize=(13,5));trajectories(axs[0],queue);axs[0].set_title('Six opposing KCCs: 6/6 arrive; radius 0.30 m');trajectories(axs[1],stress);axs[1].set_title(f'Dense two-lane stress: {stress["arrived"]}/12 arrive, {stress["blocked"]} blocked\nRecorded negative result; no global congestion guarantee');save(fig,'navmesh-trajectories.png')
geometry=load('geometry.json')['cases'];fig,axs=plt.subplots(1,2,figsize=(12,5))
for ax,name in zip(axs,['door-small','door-large']):
    r=next(c for c in geometry if c['name']==name);surface(ax,r['mesh']);gap=1.2;ax.add_patch(Rectangle((-.2,gap/2),.4,5-gap/2,color='#514c57'));ax.add_patch(Rectangle((-.2,-5),.4,5-gap/2,color='#514c57'))
    if r.get('path'):p=np.array(r['path']).reshape(-1,3);ax.plot(p[:,0],p[:,2],color='#e0a325',lw=3)
    ax.set_xlim(-3,3);ax.set_ylim(-2,2);ax.set_title(f'1.2 m door, agent radius {r["settings"]["radius"]:.2f} m\nQuery: {r["queryCode"]}')
save(fig,'door-clearance.png')
f=load('falsifiers.json');fig,axs=plt.subplots(1,2,figsize=(12,5))
for ax,key in zip(axs,['good','bad']):
    r=f['avoidance'][key];trajectories(ax,r);ax.set_xlim(-2.5,2.5);ax.set_ylim(-1,1);ax.set_title(f'Avoidance {"enabled" if key=="good" else "disabled"}\nBoth arrive; minimum center separation {r["minimumSeparation"]:.3f} m')
save(fig,'avoidance-falsifier.png')
p=load('performance.json');fig,axs=plt.subplots(2,2,figsize=(13,9));regular=[r for r in p['crowds'] if not r['instrumented']]
for i,count in enumerate([100,1000]):
    ax=axs[0,i];runs=[r for r in regular if r['agents']==count];
    for j,r in enumerate(runs):
        values=np.sort(r['fullWorld']['samples']);ax.plot(values,np.arange(1,len(values)+1)/len(values),label=f'Run {j+1}, p95={r["fullWorld"]["p95"]:.2f} ms')
    ax.axvline(p['budgets'][f'world{count}Ms'],color='crimson',ls='--',label='Fixed p95 budget');ax.axhline(.95,color='gray',ls=':');ax.set_xscale('log');ax.set_xlabel('Full World wall time (ms), all samples');ax.set_ylabel('Cumulative fraction');ax.set_title(f'{count} KCCs: 30 warmup + 370 measured frames');ax.legend(fontsize=8)
ax=axs[1,0];ax.boxplot([b['warm']['samples'] for b in p['bakes']],tick_labels=['12 triangles','600 triangles','6012 triangles']);ax.set_ylabel('Warm bake wall time (ms)');ax.set_yscale('log');ax.set_title('Same-process bake, retained cold samples in JSON')
ax=axs[1,1];names=[r['name'] for r in regular];heap=[r['memory']['after']['heapUsed']/2**20 for r in regular];rss=[r['memory']['after']['rss']/2**20 for r in regular];ax.plot(heap,'o-',label='Heap used');ax.plot(rss,'o-',label='RSS');ax.set_xticks(range(len(names)),names,rotation=30,ha='right');ax.set_ylabel('Process memory (MiB)');ax.set_title('Snapshots after workload; includes runtime/native overhead');ax.legend();save(fig,'performance-memory.png')
failures=[]
for path in ROOT.glob('performance-*.json'):
    try:
        old=json.loads(path.read_text());failures.extend((path.stem,x) for x in old.get('failures',[]) if 'value' in x)
    except (ValueError,TypeError):pass
if failures:
    fig,ax=plt.subplots(figsize=(12,5));labels=[f'{file}\n{x["name"]}' for file,x in failures];ratio=[x['value']/x['budget'] for _,x in failures];ax.bar(range(len(ratio)),ratio,color='#bc5353');ax.axhline(1,color='black',ls='--');ax.set_xticks(range(len(labels)),labels,rotation=55,ha='right',fontsize=7);ax.set_ylabel('Measured p95 / unchanged budget');ax.set_title('Retained failed performance gates');save(fig,'performance-failures.png')
if (ROOT/'allocations.json').exists():
    a=load('allocations.json');fig,axs=plt.subplots(1,2,figsize=(13,5));w=a['workloads'];x=np.arange(len(w))
    axs[0].bar(x-.25,[r['runs']['sampled']['memory']['before']['heapUsed']/2**20 for r in w],.25,label='Heap before Scene instantiation')
    axs[0].bar(x,[r['runs']['sampled']['memory']['after']['heapUsed']/2**20 for r in w],.25,label='Heap after fixed steps')
    axs[0].bar(x+.25,[r['allocation']['attributedBytes']/2**20 for r in w],.25,label='Cumulative JS allocation estimate')
    axs[0].set_xticks(x,[f'{r["count"]} characters' for r in w]);axs[0].set_yscale('log');axs[0].set_ylabel('MiB, logarithmic scale');axs[0].set_title('400 real fixed steps + setup/disposal\nAllocation includes collected objects; excludes native/WASM');axs[0].legend(fontsize=8)
    r=w[-1]
    for mode in ['direct','sampled']:
        values=np.sort(r['runs'][mode]['fullWorld']['samples']);axs[1].plot(values,np.arange(1,len(values)+1)/len(values),label=f'{mode}, p95={r["runs"][mode]["fullWorld"]["p95"]:.2f} ms')
    axs[1].axhline(.95,color='gray',ls=':');axs[1].set_xlabel('Full World wall time (ms)');axs[1].set_ylabel('Cumulative fraction');axs[1].set_title('1000 characters: allocation observer cost\nDiagnostic pair; no timing correction or acceptance claim');axs[1].legend();save(fig,'allocations.png')
print(OUT)
