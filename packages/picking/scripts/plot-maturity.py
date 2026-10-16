import json,pathlib,struct,math,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '.')
out=root/'artifacts/picking-curves'
plt.rcParams.update({'font.size':11,'axes.spines.top':False,'axes.spines.right':False})
c=json.loads((out/'curves.json').read_text())
fig,axes=plt.subplots(1,3,figsize=(16,4.5),layout='constrained')
for row in c['rows']:
 if row['closed']:continue
 ps=np.array([v['engine'] for v in row['points']]);axes[0].plot(ps[:,0],ps[:,1],label=row['parameterization'])
ctrl=np.array(c['controls']);axes[0].scatter(ctrl[:,0],ctrl[:,1],c='black',s=25);axes[0].set_title('Nonuniform controls: explicit curve modes');axes[0].legend();axes[0].set_aspect('equal')
for label,key,color in [('Parameter','regular','#db7257'),('Distance','distancePoints','#169a90')]:
 ps=np.array(c[key]);ds=np.linalg.norm(np.diff(ps,axis=0),axis=1);axes[1].plot(np.arange(len(ds))/len(ds),ds/ds.mean(),label=label,color=color)
axes[1].set_title('Step length / mean (1,000 steps)');axes[1].set_xlabel('Fraction along path');axes[1].legend()
ps=np.array(c['distancePoints']);axes[2].plot(ps[:,0],ps[:,1],c='#169a90');axes[2].scatter(ps[::25,0],ps[::25,1],s=16,c='#169a90');axes[2].set_aspect('equal');axes[2].set_title(f"Equal-distance points; variation {c['maxSpeedVariation']*100:.4f}%")
fig.savefig(out/'curves.png',dpi=180);plt.close(fig)
p=json.loads((out/'performance.json').read_text());names=['vertex-static-512','vertex-static-4096','vertex-static-16384']
fig,axes=plt.subplots(1,3,figsize=(16,4.7),layout='constrained')
labels=['1,024','8,192','32,768'];width=.34;xx=np.arange(3)
for mode,label,col,sign in [('A','Baseline','#d66a58',-1),('B','Current','#159f96',1)]:
 p50=[];p95=[];alloc=[]
 for name in names:
  rows=next(v['rows'] for v in p['raw'] if v['name']==name);times=[v['elapsedMs'] for v in rows if v['mode']==mode];times=sorted(times);p50.append(times[math.floor((len(times)-1)*.5)]);p95.append(times[math.floor((len(times)-1)*.95)]);alloc.append(np.mean([v['bytesPerQuery'] for v in p['records'] if v['name']==name and v['mode']==mode])/1e6)
 axes[0].bar(xx+sign*width/2,p50,width,label=label,color=col);axes[1].bar(xx+sign*width/2,p95,width,label=label,color=col);axes[2].bar(xx+sign*width/2,alloc,width,label=label,color=col)
for ax,title,y in zip(axes,['Vertex query p50','Vertex query p95 (shared CPU load)','V8 sampled JS allocation / query'],['ms','ms','MB (excludes external buffers)']):ax.set_title(title);ax.set_ylabel(y);ax.set_xticks(xx,labels);ax.set_xlabel('Triangles');ax.legend()
fig.suptitle('Apple M4 Pro · Node 26.4.0 · 128×128 · ABBA · 600 samples per arm')
fig.savefig(out/'performance.png',dpi=180);plt.close(fig)
# Raw RHI rgba16float: no synthetic GPU image.
def read_hdr(directory,name='posed'):
 m=json.loads((directory/(name+'-image.json')).read_text());b=(directory/(name+'.rgba16f')).read_bytes();a=np.zeros((m['height'],m['width'],3))
 for y in range(m['height']):
  for x in range(m['width']):a[y,x]=struct.unpack_from('<4e',b,y*m['bytesPerRow']+x*8)[:3]
 return np.clip(np.where(a<=.0031308,a*12.92,1.055*np.maximum(a,0)**(1/2.4)-.055),0,1)
d=root/'artifacts/morph-triangle-picking/dawn/morph';img=read_hdr(d);facts=json.loads((d/'posed-inspection.json').read_text());before=json.loads((out/'before-picks.json').read_text())
fig,axes=plt.subplots(1,2,figsize=(10,5.2),layout='constrained')
for ax,title,picks,col in [(axes[0],'Baseline query on same GPU frame',before['picks'],'#ff4f57'),(axes[1],'Current Morph query',facts['picks'],'#20f6b5')]:
 ax.imshow(img,origin='upper');pts=np.array([p['pixel'] for p in picks]);ax.scatter(pts[:,0],pts[:,1],s=35,facecolors='none',edgecolors=col,linewidths=1.5);ax.set_title(title);ax.set_xlim(0,127);ax.set_ylim(127,0);ax.set_xlabel('GPU image and exact query pixel centers')
fig.suptitle('Morph +0.6 X · dots show exact triangle hits · replay max error 0')
fig.savefig(out/'morph-before-after.png',dpi=200);plt.close(fig)
