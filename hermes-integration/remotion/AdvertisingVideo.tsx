import React from 'react';
import {AbsoluteFill, Composition, Img, Sequence, interpolate, registerRoot, spring, useCurrentFrame} from 'remotion';

type Family = 'product' | 'technology' | 'saas' | 'motion' | 'ui' | 'social' | 'cinematic' | 'comedy';
type Scene = {title: string; subtitle?: string; frames: number; image?: number; role?: string; motion?: string;
  overlay?: {type: string; label?: string; value?: string}};
type Props = {scenes: Scene[]; images: string[]; accent: string; frames: number};
const defaults: Props = {frames: 90, accent: '#6ee7b7', images: [], scenes: [
  {title: 'Motion graphics', subtitle: 'Frame-by-frame animation', frames: 90, role: 'hook', motion: 'reveal'},
]};
const skins = {
  product: {bg:'#e5e9dc', ink:'#172019', panel:'#f7f8f1', x:60, y:490, w:960, h:990, fit:'contain'},
  technology: {bg:'#07141d', ink:'#eefbff', panel:'#102939', x:54, y:478, w:972, h:1090, fit:'cover'},
  saas: {bg:'#e5ece9', ink:'#172b2b', panel:'#f9fcfb', x:76, y:570, w:928, h:900, fit:'contain'},
  motion: {bg:'#17142b', ink:'#fff5e4', panel:'#252142', x:80, y:530, w:920, h:880, fit:'contain'},
  ui: {bg:'#161825', ink:'#f7f7fb', panel:'#202c42', x:160, y:480, w:760, h:1090, fit:'contain'},
  social: {bg:'#272137', ink:'#fff8eb', panel:'#3b3454', x:52, y:475, w:976, h:1060, fit:'cover'},
  cinematic: {bg:'#111313', ink:'#f6f3e9', panel:'#242723', x:0, y:370, w:1080, h:1220, fit:'cover'},
  comedy: {bg:'#ffecbb', ink:'#281b39', panel:'#fff9e9', x:76, y:570, w:928, h:910, fit:'contain'},
} as const;
const clamp = {extrapolateLeft:'clamp', extrapolateRight:'clamp'} as const;
const ids: Record<Family,string> = {product:'ProductCommercial', technology:'TechnologyDemo', saas:'SaasAd',
  motion:'MotionGraphics', ui:'UiAnimation', social:'SocialAd', cinematic:'CinematicShowcase', comedy:'AnimatedComedy'};

function Diagram({scene, accent, progress, ink}: {scene:Scene; accent:string; progress:number; ink:string}) {
  const overlay = scene.overlay;
  const type = overlay?.type ?? 'workflow';
  const eased = Math.max(0, Math.min(1, progress));
  return <svg viewBox="0 0 800 800" width="100%" height="100%" style={{overflow:'visible'}} role="presentation">
    {type === 'tracking' && <>
      <rect x="150" y="130" width="500" height="540" rx="28" fill="none" stroke={accent} strokeWidth="5" opacity=".5"/>
      <path d="M165 250 V150 H265 M535 150 H635 V250 M635 550 V650 H535 M265 650 H165 V550" fill="none" stroke={accent} strokeWidth="13"/>
      <line x1="168" x2="632" y1={160+eased*457} y2={160+eased*457} stroke={accent} strokeWidth="7"/>
      <circle cx="400" cy="400" r={40+eased*45} fill="none" stroke={accent} strokeWidth="4"/>
    </>}
    {type === 'metric' && <g transform="translate(112 120)">
      {[.36,.56,.46,.73,.89].map((v,i)=><rect key={i} x={i*120} y={512-v*490*eased} width="84" height={v*490*eased} rx="16" fill={accent} opacity={.48+i*.13}/>)}
      <path d="M0 526H575" stroke={ink} strokeWidth="4" opacity=".3"/>
    </g>}
    {type === 'workflow' && <g fill="none" stroke={accent} strokeWidth="7">
      <path d="M155 260 H410 V520 H645" pathLength="100" strokeDasharray="100" strokeDashoffset={100-100*eased}/>
      {[ [155,260],[410,260],[410,520],[645,520] ].map(([x,y],i)=><g key={i} transform={'translate('+x+' '+y+')'} opacity={Math.max(0,(eased-i*.18)*4)}>
        <rect x="-68" y="-60" width="136" height="120" rx="22" fill={accent} fillOpacity=".28"/>
        <circle r="24" fill={accent}/></g>)}
    </g>}
    {type === 'badge' && <g transform={'translate(400 400) scale('+eased+')'}>
      <circle r="155" stroke={accent} strokeWidth="15" fill={accent} fillOpacity=".15"/>
      <path d="M-56 0l38 38 80-85" fill="none" stroke={accent} strokeWidth="20" strokeLinecap="round"/>
    </g>}
  </svg>;
}

function VisualFrame({family, role, accent, entry}: {family:Family; role:string; accent:string; entry:number}) {
  if (family === 'technology' || family === 'ui' || family === 'saas') {
    const phone = family === 'ui';
    return <div style={{position:'absolute',left:0,top:0,right:0,height:phone?54:58,
      background:family==='saas'?'#eff7f3':'#101e2de8',display:'flex',alignItems:'center',
      justifyContent:phone?'center':'space-between',padding:'0 25px',zIndex:1}}>
      {phone ? <div style={{background:'#52667d',width:126,height:13,borderRadius:20}}/> : <>
        <div style={{display:'flex',gap:11,alignItems:'center'}}>
          {[0,1,2].map(i=><span key={i} style={{background:accent,opacity:1-i*.24,width:11,height:11,borderRadius:10}}/>)}
        </div>
        <div style={{width:family==='saas'?320:108,height:4,borderRadius:4,background:accent,
          transform:'scaleX('+entry+')',transformOrigin:'right'}}/>
      </>}
    </div>;
  }
  if (family === 'product' && role !== 'cta') {
    return <div style={{position:'absolute',top:32,left:36,opacity:entry,width:77,height:42,
      borderTop:'5px solid '+accent,borderLeft:'5px solid '+accent,borderRadius:'14px 0 0 0'}}/>;
  }
  if (family === 'comedy' && role === 'punchline') {
    return <svg viewBox="0 0 900 900" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}>
      {Array.from({length:12},(_,i)=><path key={i} d="M450 95 L450 160" stroke={accent} strokeWidth={10+i%3}
        strokeLinecap="round" opacity={entry} transform={'rotate('+(i*30)+' 450 450)'}/>)}
    </svg>;
  }
  return null;
}

function SceneView({scene, family, src, accent, index, total}: {scene:Scene; family:Family; src?:string; accent:string; index:number; total:number}) {
  const f = useCurrentFrame();
  const skin = skins[family];
  const role = scene.role ?? (index === 0 ? 'hook' : index === total-1 ? 'cta' : 'demo');
  const mode = scene.motion ?? (family === 'cinematic' ? 'parallax' : role === 'hook' ? 'reveal' : 'push');
  const p = f / Math.max(1, scene.frames-1);
  const enter = spring({fps:30,frame:f,config:{damping:19,stiffness:120},durationInFrames:24});
  const opacity = interpolate(f,[0,5,Math.max(6,scene.frames-6),scene.frames],[.2,1,1,.5],clamp);
  const x = mode === 'pan' ? (p-.5)*100 : mode === 'parallax' ? (p-.5)*48 : 0;
  const y = mode === 'still' ? 0 : (1-enter)*66+(mode === 'parallax' ? -50*p : 0);
  const rotation = (family === 'product' && mode === 'reveal') ? -7*(1-enter) : 0;
  const scale = mode === 'still' ? 1 : mode === 'snap' ? 1.16-(.15*enter) :
    mode === 'reveal' ? .88+.12*enter : mode === 'pan' || mode === 'parallax' ? 1.12+p*.07 : 1+p*.12;
  const light = ['product','saas','comedy'].includes(family);
  const words = scene.title.split(/\s+/);
  const textSize = scene.title.length > 58 ? 62 : scene.title.length > 35 ? 76 : 100;
  const double = family === 'cinematic' || family === 'social';
  const profileBorder = family === 'ui' ? '14px solid #71839a' : '2px solid '+accent+'75';
  return <AbsoluteFill style={{background:skin.bg,color:skin.ink,fontFamily:'Arial, sans-serif',opacity,overflow:'hidden'}}>
    <span style={{position:'absolute',top:80,left:72,width:138,height:9,background:accent,
      transform:'scaleX('+enter+')',transformOrigin:'left'}}/>
    <span style={{position:'absolute',top:66,right:73,fontSize:26,fontWeight:800,opacity:.65}}>
      {String(index+1).padStart(2,'0')} / {String(total).padStart(2,'0')}</span>
    <div style={{position:'absolute',left:skin.x,top:skin.y,width:skin.w,height:skin.h,overflow:'hidden',boxSizing:'border-box',
      border:profileBorder,borderRadius:family==='ui'?76:double?18:42,background:skin.panel,
      transform:'translateY('+((1-enter)*55)+'px)',boxShadow:light?'0 30px 80px #253a2129':'0 45px 110px #0008'}}>
      {src && <>
        {mode === 'parallax' && <Img src={src} style={{position:'absolute',width:'100%',height:'100%',objectFit:'cover',filter:'blur(23px) brightness(.55)',transform:'scale(1.35)'}}/>}
        <Img src={src} style={{position:'absolute',width:'100%',height:'100%',objectFit:skin.fit,
          transform:'translate('+x+'px,'+y+'px) scale('+scale+') rotate('+rotation+'deg)',
          filter:family==='product'?'drop-shadow(0 30px 22px #0b1c1b4a)':undefined}}/>
      </>}
      {(!src || scene.overlay) && <div style={{position:'absolute',inset:0,opacity:src ? .8 : 1}}>
        <Diagram scene={scene} accent={accent} progress={interpolate(f,[0,Math.min(50,scene.frames-1)],[0,1],clamp)} ink={skin.ink}/>
      </div>}
      <VisualFrame family={family} role={role} accent={accent} entry={enter}/>
      {scene.overlay?.label && <div style={{position:'absolute',bottom:35,left:36,right:36,background:skin.bg,color:skin.ink,
        borderLeft:'8px solid '+accent,borderRadius:16,padding:'22px 24px',display:'flex',justifyContent:'space-between',
        fontSize:33,fontWeight:800,opacity:enter}}><span>{scene.overlay.label}</span><span>{scene.overlay.value}</span></div>}
    </div>
    <div style={{position:'absolute',left:75,right:75,top:155,fontSize:textSize,fontWeight:900,lineHeight:1.02,
      letterSpacing:-textSize*.035,textWrap:'balance'}}>
      {words.map((word,i)=>{
        const wordSpring = spring({fps:30,frame:Math.max(0,f-i*2),config:{damping:20,stiffness:140},durationInFrames:22});
        return <React.Fragment key={i}><span style={{display:'inline-block',opacity:wordSpring,
          transform:'translateY('+((1-wordSpring)*32)+'px) rotate('+((family==='comedy'?-6:0)*(1-wordSpring))+'deg)'}}>{word}</span>{' '}</React.Fragment>;
      })}
    </div>
    <div style={{position:'absolute',left:74,right:74,bottom:116,
      padding:role==='cta'?'32px 42px':'22px 0',background:role==='cta'?accent:'transparent',
      color:role==='cta'?'#10201e':skin.ink,borderRadius:role==='cta'?25:0,
      borderTop:role==='cta'?undefined:'2px solid '+accent,opacity:enter,transform:'translateY('+((1-enter)*54)+'px)',
      display:'flex',alignItems:'center',justifyContent:'space-between',gap:26,fontSize:role==='cta'?48:40,fontWeight:800}}>
      <span>{scene.subtitle}</span>{role==='cta'&&scene.subtitle&&<span style={{fontSize:62}}>↗</span>}
    </div>
  </AbsoluteFill>;
}

function createVideo(family:Family) {
  return function AdvertisingVideo({scenes,images,accent}:Props) {
    let start=0;
    return <AbsoluteFill style={{background:skins[family].bg}}>
      {scenes.map((scene,index)=>{
        const from = start;
        start += scene.frames;
        return <Sequence key={index} from={from} durationInFrames={scene.frames}>
          <SceneView scene={scene} family={family} src={scene.image===undefined?undefined:images[scene.image]} accent={accent} index={index} total={scenes.length}/>
        </Sequence>;
      })}
    </AbsoluteFill>;
  };
}
registerRoot(()=> <>{(Object.keys(ids) as Family[]).map((family)=>
  <Composition key={family} id={ids[family]} component={createVideo(family)} width={1080} height={1920} fps={30}
    durationInFrames={90} defaultProps={defaults} calculateMetadata={({props})=>({durationInFrames:props.frames})}/>
)}</>);
