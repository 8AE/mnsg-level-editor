import { _electron as electron } from "playwright";
import * as THREE from "three";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareEditableRoom } from "../components/editableRoom.ts";
import { rotatePoint, rotationQuaternion } from "../components/selectionRotation.ts";

const rom = process.env.MNSG_TEST_ROM;
if (!rom) throw Error("Set MNSG_TEST_ROM to your own US MNSG ROM.");
const artifacts = await realpath(await mkdtemp(path.join(tmpdir(), "mnsg-scene-tools-")));
const profile = path.join(artifacts, "profile"), projectPath = path.join(artifacts, "scene.mnsgproj");
await mkdir(profile);
const wrapper = path.join(artifacts, "launch.cjs");
await writeFile(wrapper, `const {app,dialog}=require('electron');app.setPath('userData',${JSON.stringify(profile)});globalThis.__sceneSmoke={open:[],save:[]};dialog.showOpenDialog=async()=>({canceled:false,filePaths:globalThis.__sceneSmoke.open.shift()||[]});dialog.showSaveDialog=async()=>({canceled:false,filePath:globalThis.__sceneSmoke.save.shift()});dialog.showMessageBoxSync=()=>1;require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});`);
const env = { ...process.env };delete env.ELECTRON_RUN_AS_NODE;delete env.MNSG_DEV_URL;
const app = await electron.launch({ args: [wrapper], env, timeout: 30000 });
const report = { artifacts, milestones: [], errors: [] };
const button = (page, name) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const milestone = async name => { report.milestones.push(name);console.log("PASS " + name);await writeFile(path.join(artifacts,"scene-tools.json"), JSON.stringify(report,null,2)); };
let main, scene;
const idle = async () => { await main.waitForFunction(() => !document.querySelector('.busy-state'));await main.locator('.viewport-loading').waitFor({ state: 'hidden' }); };
const data = page => page.locator('[data-testid="viewport-canvas"]').evaluate(el => ({ ...el.dataset }));
const selection = async page => JSON.parse((await data(page)).selectionChoices);
let opened = projectPath;
async function save() { await idle();await button(main,"Save").click();await main.locator('.dirty-state').waitFor({ state:'hidden' });return JSON.parse(await readFile(opened,"utf8")); }
async function point(page, p) {
  const bounds = await page.locator('[data-testid="viewport-navigation-canvas"]').boundingBox(), state = await data(page);
  const camera = new THREE.PerspectiveCamera(42, bounds.width/bounds.height,.5,250000);
  camera.position.fromArray(state.cameraPosition.split(',').map(Number));camera.lookAt(new THREE.Vector3().fromArray(state.cameraTarget.split(',').map(Number)));camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(p.x,p.y,p.z).project(camera);
  return { x:bounds.x+(v.x+1)*bounds.width/2,y:bounds.y+(1-v.y)*bounds.height/2 };
}
async function dragRing(page) {
  await button(page,"Toggle rotation gizmo").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="viewport-canvas"]')?.dataset.transformMode === 'rotate');
  const state = await data(page), position = state.transformPreviewPosition.split(',').map(Number), pivot={x:position[0],y:position[1],z:position[2]}, center=await point(page,pivot);
  let hit;
  for (const radius of [65,48,82,32,100]) {
    for (let i=0;i<32;i++) {
      const angle=i*Math.PI/16, p={x:center.x+Math.cos(angle)*radius,y:center.y+Math.sin(angle)*radius*.65};
      await page.mouse.move(p.x,p.y);
      const axis=(await data(page)).transformAxis;
      if(axis==='Y'){hit=p;break;}
    }
    if(hit)break;
  }
  assert.ok(hit,'a visible Y rotation ring is pointer-pickable');
  await page.mouse.down();
  assert.equal((await data(page)).transformDragging,'true');
  const angle=Math.atan2(hit.y-center.y,hit.x-center.x)+.55,radius=Math.hypot(hit.x-center.x,hit.y-center.y);
  await page.mouse.move(center.x+Math.cos(angle)*radius,center.y+Math.sin(angle)*radius,{steps:8});
  const preview=(await data(page)).transformPreviewRotation.split(',').map(Number);
  assert.ok(Math.hypot(...preview.slice(0,3))>.02,'drag produces a real rotation preview');
  await page.mouse.up();await idle();
  return { delta:{x:preview[0],y:preview[1],z:preview[2],w:preview[3]},pivot };
}
try {
  main=await app.firstWindow();main.setDefaultTimeout(30000);main.on('pageerror',error=>report.errors.push(error.message));
  main.on('dialog',dialog=>void dialog.accept().catch(()=>{}));
  await main.waitForFunction(()=>Boolean(window.mnsg));
  await app.evaluate((_e,p)=>globalThis.__sceneSmoke.open.push([p]),rom);await button(main,'Choose US ROM').click();
  await main.locator('[data-room-id="465"]').waitFor({timeout:120000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).setSize(1440,960));
  await main.locator('[data-room-id="465"]').click();await idle();
  await main.waitForFunction(()=>Number(document.querySelector('[data-testid="viewport-canvas"]')?.dataset.authoredMeshCount)>0);
  await app.evaluate((_e,p)=>globalThis.__sceneSmoke.save.push(p),projectPath);
  const initial=await save();assert.deepEqual(initial.authoredRooms,{});assert.deepEqual(initial.roomOverrides,{});
  assert.equal(await main.locator('.view-tag,.axis-key,.viewport-bottom-overlay').count(),0);
  assert.equal(await main.locator('.viewport-stage [data-testid="viewport-navigation-hint"]').count(),0);
  assert.equal(await main.locator('[data-testid="viewport-navigation-hint"]').count(),1);
  assert.equal(await button(main,'Make editable copy').count(),0);
  const beforeCompass=await main.locator('[data-testid="scene-compass"]').getAttribute('data-orientation');
  const canvas=await main.locator('[data-testid="viewport-navigation-canvas"]').boundingBox();
  await main.mouse.move(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await main.mouse.down();await main.mouse.move(canvas.x+canvas.width/2+95,canvas.y+canvas.height/2+25,{steps:12});await main.mouse.up();
  await main.waitForFunction(before=>document.querySelector('[data-testid="scene-compass"]')?.dataset.orientation!==before,beforeCompass);
  assert.deepEqual((await save()).authoredRooms,{});
  await milestone('native rooms are editable immediately; compass follows orbit; opening/navigation leave the project clean');
  await button(main,'Toggle rotation gizmo').hover();await main.getByRole('tooltip').waitFor();assert.match(await main.getByRole('tooltip').innerText(),/Rotate/);
  await main.keyboard.press('Escape');await main.getByRole('tooltip').waitFor({state:'hidden'});
  await button(main,'Frame all geometry').focus();await main.getByRole('tooltip').waitFor();assert.match(await main.getByRole('tooltip').innerText(),/Frame/);
  const contrast=await main.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
    const luminance=values=>values.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratio=(foreground,background,opacity=1)=>{const bg=rgb(background),fg=rgb(foreground).map((v,i)=>v*opacity+bg[i]*(1-opacity)),a=luminance(fg),b=luminance(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
    const tooltip=getComputedStyle(document.querySelector('[role="tooltip"]')),compass=getComputedStyle(document.querySelector('[data-testid="scene-compass"]'));
    return {tooltip:ratio(tooltip.color,tooltip.backgroundColor),axes:[...document.querySelectorAll('.compass-axis')].map(el=>{const style=getComputedStyle(el);return {color:style.color,ratio:ratio(style.color,compass.backgroundColor,Number(style.opacity))};})};
  });
  assert.ok(contrast.tooltip>=4.5,'tooltip text meets 4.5:1 contrast');
  assert.equal(new Set(contrast.axes.map(axis=>axis.color)).size,3,'compass axes have distinct colors');
  assert.ok(contrast.axes.every(axis=>axis.ratio>=4.5),'compass letters remain readable at rear-axis opacity');
  await milestone('icon tooltips work on hover and keyboard focus and dismiss with Escape');
  await button(main,'Frame all geometry').click();
  const native=await main.evaluate(()=>window.mnsg.loadRoom(465)), actor=native.actors.find(a=>a.editable&&a.sourceKind!=='partition');
  await main.locator(`[data-record-id="${actor.id}"]`).click();await button(main,'Frame selected record').click();
  const selectedBefore=await selection(main);await dragRing(main);
  assert.deepEqual(await selection(main),selectedBefore);
  let graph=await save();assert.notDeepEqual(graph.roomOverrides[465].actors[actor.id].rotation,actor.rotation);assert.deepEqual(graph.roomOverrides[465].actors[actor.id].position,actor.position);
  await button(main,'Undo').click();await idle();assert.deepEqual((await save()).roomOverrides,initial.roomOverrides);
  await milestone('native actor rotation persists raw angles, keeps its position and selection, and Undo restores it');
  // Directly pick and rotate native geometry without entering the Geometry tab.
  await button(main,'Frame all geometry').click();
  await main.locator('.viewport-controls').getByRole('button',{name:'Actors',exact:true}).click();
  await main.locator('.viewport-controls').getByRole('button',{name:'Events',exact:true}).click();
  const display=native.meshes.filter(m=>m.source==='display-list');
  let nativeMeshSelected=false;
  for(const mesh of display) {
    const ids=mesh.indices.slice(0,3),center={x:0,y:0,z:0};
    for(const i of ids){center.x+=mesh.positions[i*3]/3;center.y+=mesh.positions[i*3+1]/3;center.z+=mesh.positions[i*3+2]/3;}
    const pixel=await point(main,center),bounds=await main.locator('[data-testid="viewport-navigation-canvas"]').boundingBox();
    if(pixel.x<bounds.x+110||pixel.x>bounds.x+bounds.width-40||pixel.y<bounds.y+110||pixel.y>bounds.y+bounds.height-20)continue;
    await main.mouse.click(pixel.x,pixel.y);
    if((await selection(main))[0]?.kind==='geometry'){nativeMeshSelected=true;break;}
  }
  assert.ok(nativeMeshSelected,'a native surface can be selected directly in the default viewer');
  assert.deepEqual((await save()).authoredRooms,{});
  const nativeMeshChoice=await selection(main);
  await button(main,'Frame selected record').click();
  if(await button(main,'Toggle rotation gizmo').getAttribute('aria-pressed')==='true')await button(main,'Toggle rotation gizmo').click();
  await dragRing(main);graph=await save();
  assert.equal(graph.authoredRooms[465].meshes.length,display.length);
  assert.equal(graph.authoredRooms[465].actors.length,native.actors.length);
  assert.deepEqual(await selection(main),nativeMeshChoice);
  await button(main,'Undo').click();await idle();
  await main.waitForFunction(()=>Number(document.querySelector('[data-testid="viewport-canvas"]')?.dataset.authoredMeshCount)>0);
  assert.deepEqual((await save()).authoredRooms,{});
  assert.deepEqual(await selection(main),nativeMeshChoice);
  await milestone('first native geometry rotation creates one undoable replacement, preserves the full roster and retains selection after Undo');
  const catalog=await main.evaluate(()=>window.mnsg.getAuthoringCatalog());
  const source=await main.evaluate(p=>window.mnsg.loadProjectRoom(p,465),initial);
  const entry=catalog.geometry.find(a=>a.roomIds.includes(465)&&a.id.startsWith('geometry:'));
  const asset=await main.evaluate(id=>window.mnsg.loadGeometryAsset(id),entry.id);
  const authored=prepareEditableRoom(source,catalog,asset).authored, materialId=authored.materials[0].id;
  const v=(x,z)=>({position:{x,y:0,z},uv:[x/200,z/200],color:[255,255,255,255]});
  authored.meshes=[{id:'rotation-quad',materialId,vertices:[v(-100,-100),v(100,-100),v(100,100),v(-100,100)],indices:[0,2,1,0,3,2]}];
  authored.actors=[];authored.doors=[];authored.entrances=[];
  const fixture={...initial,authoredRooms:{465:authored}}, fixturePath=path.join(artifacts,'shared-faces.mnsgproj');await writeFile(fixturePath,JSON.stringify(fixture));
  await app.evaluate((_e,p)=>globalThis.__sceneSmoke.open.push([p]),fixturePath);await button(main,'Open').click();opened=fixturePath;await idle();
  await button(main,'Frame all geometry').click();
  const p=await point(main,{x:35,y:0,z:-35});await main.mouse.click(p.x,p.y);
  await main.waitForFunction(()=>document.querySelector('[data-testid="viewport-canvas"]')?.dataset.selectionOutline==='mesh');
  await button(main,'face').click();
  const first=await point(main,{x:35,y:0,z:-35}), second=await point(main,{x:-35,y:0,z:35});
  await main.mouse.click(first.x,first.y);await main.keyboard.down(process.platform==='darwin'?'Meta':'Control');await main.mouse.click(second.x,second.y);await main.keyboard.up(process.platform==='darwin'?'Meta':'Control');
  await main.waitForFunction(()=>document.querySelector('[data-testid="viewport-canvas"]')?.dataset.selectionCount==='2');
  const faces=await selection(main), original=structuredClone(authored.meshes[0]);
  // Actor rotation left the tool active; make the next tool activation explicit.
  if(await button(main,'Toggle rotation gizmo').getAttribute('aria-pressed')==='true')await button(main,'Toggle rotation gizmo').click();
  const rotation=await dragRing(main);assert.deepEqual(await selection(main),faces);graph=await save();
  const q=rotationQuaternion(rotation.delta);
  assert.deepEqual(graph.authoredRooms[465].meshes[0].vertices.map(v=>v.position),original.vertices.map(v=>rotatePoint(v.position,rotation.pivot,q)));
  await button(main,'Undo').click();await idle();assert.deepEqual(await selection(main),faces);assert.deepEqual((await save()).authoredRooms[465].meshes[0],original);
  await milestone('multiple faces rotate about their shared center, shared vertices change once, and selection survives rotation and Undo');
  const popup=app.waitForEvent('window');await button(main,'Pop out Scene').click();scene=await popup;scene.setDefaultTimeout(30000);scene.on('pageerror',error=>report.errors.push(error.message));
  await scene.locator('[data-testid="viewport-navigation-canvas"]').waitFor();await scene.bringToFront();
  assert.deepEqual(await selection(scene),faces);
  await button(scene,'Toggle rotation gizmo').hover();await scene.getByRole('tooltip').waitFor();assert.equal(await scene.locator('[role="tooltip"]').evaluate(el=>el.ownerDocument===document),true);
  assert.equal(await scene.locator('[data-testid="viewport-navigation-hint"]').count(),1);
  assert.equal(await scene.locator('[data-testid="scene-compass"]').count(),1);
  if(await button(scene,'Toggle rotation gizmo').getAttribute('aria-pressed')==='true')await button(scene,'Toggle rotation gizmo').click();
  await dragRing(scene);assert.deepEqual(await selection(scene),faces);graph=await save();assert.notDeepEqual(graph.authoredRooms[465].meshes[0],original);
  await button(scene,'Undo').click();await idle();assert.deepEqual((await save()).authoredRooms[465].meshes[0],original);
  await scene.screenshot({path:path.join(artifacts,'scene-popout.png')});
  await button(scene,'Redock Scene').click();await main.bringToFront();await main.locator('[data-testid="viewport-navigation-canvas"]').waitFor();
  assert.deepEqual(await selection(main),faces);
  await main.screenshot({path:path.join(artifacts,'scene-workspace.png')});
  await milestone('Scene popout retains compass, bottom help, tooltips and shared rotation/Undo without dropping selection');
  // A valid native-size mesh can overflow when rotated. Its rejected preview must reset.
  const bounded=JSON.parse(JSON.stringify(fixture)), boundedMesh=bounded.authoredRooms[465].meshes[0];
  boundedMesh.vertices.forEach(vertex=>{vertex.position.x*=327;vertex.position.z*=327;});
  const boundedPath=path.join(artifacts,'rotation-overflow.mnsgproj');await writeFile(boundedPath,JSON.stringify(bounded));
  await app.evaluate((_e,p)=>globalThis.__sceneSmoke.open.push([p]),boundedPath);await button(main,'Open').click();opened=boundedPath;await idle();
  await main.getByTestId('authored-geometry-list').locator('[data-mesh-id="rotation-quad"]').click();
  if(await button(main,'Toggle rotation gizmo').getAttribute('aria-pressed')==='true')await button(main,'Toggle rotation gizmo').click();
  await button(main,'Frame all geometry').click();await main.waitForTimeout(400);
  const imageHash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const sourcePixels=imageHash(await main.getByTestId('viewport-navigation-canvas').screenshot()), boundedChoice=await selection(main);
  await dragRing(main);await main.locator('.error-banner').filter({hasText:/Vertex coordinates/}).waitFor();
  assert.deepEqual((await save()).authoredRooms,bounded.authoredRooms);assert.deepEqual(await selection(main),boundedChoice);
  assert(await button(main,'Undo').isDisabled(),'rejected rotation creates no history entry');
  // Saving clears the transient error banner through the normal operation boundary.
  await button(main,'Frame all geometry').click();await main.waitForTimeout(400);
  assert.equal(imageHash(await main.getByTestId('viewport-navigation-canvas').screenshot()),sourcePixels,'rejection restores the exact original rendered geometry');
  await milestone('out-of-bounds rotation leaves the project and Undo unchanged, retains selection and restores the original viewport pixels');
  assert.deepEqual(report.errors,[]);await writeFile(path.join(artifacts,'scene-tools.json'),JSON.stringify({...report,status:'passed'},null,2));console.log(artifacts);
} catch(error) { report.error=error.stack;await writeFile(path.join(artifacts,'scene-tools.json'),JSON.stringify({...report,status:'failed'},null,2));if(main)await main.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});throw error; }
finally { await app.close(); }
