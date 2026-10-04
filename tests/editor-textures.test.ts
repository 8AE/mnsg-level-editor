import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import type { GeometryMesh, GeometryTexture } from "../shared/types";
import { createNativeSurfaceMaterial, decodeTexturePixels, linearNativeColors, RoomTexturePool } from "../components/roomMaterials";

const source: GeometryTexture = { id: "asymmetric-fixture", width: 2, height: 2, format: "test RGBA", rgbaBase64: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 0]).toString("base64") };
const sampler = { wrapS: "repeat", wrapT: "clamp", filter: "nearest" } as const;
const surface: GeometryMesh = { id: "fixture", source: "display-list", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], uvs: [0.25, 0.25, 0.75, 0.25, 0.25, 0.75], material: { ...sampler, textureId: source.id, color: [1, 1, 1], opacity: 1, alphaTest: 0, lighting: false, vertexColors: false } };

test("ROM texture upload preserves row order and uses explicit sampler settings", () => {
  const pool = new RoomTexturePool([source]);
  const decoded = pool.get(source.id, sampler);
  assert.deepEqual([...decoded.texture.image.data!], [...decodeTexturePixels(source)]);
  assert.equal(decoded.texture.flipY, false);
  assert.equal(decoded.texture.wrapS, THREE.RepeatWrapping);
  assert.equal(decoded.texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(decoded.texture.magFilter, THREE.NearestFilter);
  assert.equal(decoded.texture.minFilter, THREE.NearestFilter);
  assert.equal(decoded.texture.generateMipmaps, false);
  assert.equal(decoded.texture.premultiplyAlpha, false);
  assert.equal(decoded.texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(decoded.alpha, true);
  pool.dispose();
});

test("sampler uploads are deduplicated and all texture resources are disposed", () => {
  const pool = new RoomTexturePool([source]);
  const first = pool.get(source.id, sampler).texture;
  assert.equal(pool.get(source.id, sampler).texture, first);
  const second = pool.get(source.id, { ...sampler, wrapS: "mirror", filter: "linear" }).texture;
  assert.notEqual(second, first);
  assert.equal(second.image.data, first.image.data, "samplers share decoded CPU pixels");
  assert.equal(second.wrapS, THREE.MirroredRepeatWrapping);
  assert.equal(second.minFilter, THREE.LinearFilter);
  let disposed = 0;
  first.addEventListener("dispose", () => disposed++); second.addEventListener("dispose", () => disposed++);
  assert.equal(pool.size, 2); pool.dispose(); pool.dispose();
  assert.equal(disposed, 2); assert.equal(pool.size, 0);
});

test("native cutout and transparent materials retain alpha behavior without arbitrary texture tint", () => {
  const pool = new RoomTexturePool([source]);
  const transparent = createNativeSurfaceMaterial(surface, pool);
  assert.equal(transparent.textured, true); assert.equal(transparent.material.transparent, true); assert.equal(transparent.material.depthWrite, false);
  assert.deepEqual(transparent.material.color.toArray(), [1, 1, 1]);
  const cutout = createNativeSurfaceMaterial({ ...surface, material: { ...surface.material!, alphaTest: 0.5 } }, pool);
  assert.equal(cutout.material.transparent, false); assert.equal(cutout.material.depthWrite, true); assert.equal(cutout.material.alphaTest, 0.5);
  const lit = createNativeSurfaceMaterial({ ...surface, colors: [1, 0, 0, 1, 0, 0, 1, 0, 0], material: { ...surface.material!, lighting: true, vertexColors: true } }, pool);
  assert.equal(lit.material.vertexColors, false, "normal bytes under native lighting must not become RGB colors");
  [transparent, cutout, lit].forEach(item => item.material.dispose()); pool.dispose();
});

test("invalid texture bytes and missing UVs report solid fallback instead of textured coverage", () => {
  const malformed = { ...source, rgbaBase64: "AA==" };
  assert.throws(() => decodeTexturePixels({ ...source, width: 1024, height: 1024 }), /pixel budget/);
  assert.throws(() => decodeTexturePixels(malformed), /expected RGBA pixels/);
  const pool = new RoomTexturePool([malformed]);
  const fallback = createNativeSurfaceMaterial(surface, pool);
  assert.equal(fallback.textured, false); assert.match(fallback.warning!, /expected RGBA pixels/); assert.equal(pool.size, 0);
  const noUv = createNativeSurfaceMaterial({ ...surface, uvs: undefined }, pool);
  assert.equal(noUv.textured, false); assert.match(noUv.warning!, /no verified UV/);
  fallback.material.dispose(); noUv.material.dispose(); pool.dispose();
});

test("native middle-gray primitive and unlit shade bytes convert to the GPU linear color space", () => {
  const pool = new RoomTexturePool();
  const gray = 127 / 255;
  const native = createNativeSurfaceMaterial({ ...surface, material: { ...surface.material!, textureId: undefined, color: [gray, gray, gray] } }, pool);
  const displayed = native.material.color.clone().convertLinearToSRGB();
  assert(Math.abs(displayed.r * 255 - 127) < 0.01);
  const values = linearNativeColors([gray, gray, gray]);
  assert(Math.abs(values[0] - native.material.color.r) < 0.00001);
  native.material.dispose(); pool.dispose();
});

test("GPU asymmetric ROM-row fixture verifies orientation, texel centers, wrap/mirror/clamp and alpha", { skip: process.env.MNSG_GPU_TEST !== "1" }, async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bundle = await build({ stdin: { contents: `import * as THREE from "three"; import {RoomTexturePool,createNativeSurfaceMaterial,linearNativeColors} from "./components/roomMaterials";
window.runFixture=(source)=>{
const renderer=new THREE.WebGLRenderer({antialias:false,alpha:true,preserveDrawingBuffer:true});renderer.setSize(256,256);renderer.setClearColor(0x000000,0);document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,10);camera.position.z=2;
const geometry=new THREE.PlaneGeometry(2,2);geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1,1,1],2));
const pool=new RoomTexturePool([source]);const state={textureId:source.id,wrapS:'clamp',wrapT:'clamp',filter:'nearest',color:[1,1,1],opacity:1,alphaTest:0,vertexColors:false,lighting:false};
const material=createNativeSurfaceMaterial({id:'fixture',source:'display-list',positions:Array.from(geometry.attributes.position.array),indices:Array.from(geometry.index.array),uvs:Array.from(geometry.attributes.uv.array),material:state},pool).material;
const mesh=new THREE.Mesh(geometry,material);scene.add(mesh);const target=new THREE.WebGLRenderTarget(2,2);renderer.setRenderTarget(target);renderer.render(scene,camera);const rows=new Uint8Array(16);renderer.readRenderTargetPixels(target,0,0,2,2,rows);renderer.setRenderTarget(null);renderer.render(scene,camera);
window.sampleFixture=(u,v,wrapS,wrapT,filter='nearest')=>{const point=new THREE.PlaneGeometry(2,2);point.setAttribute('uv',new THREE.Float32BufferAttribute([u,v,u,v,u,v,u,v],2));const mat=createNativeSurfaceMaterial({id:'point',source:'display-list',positions:Array.from(point.attributes.position.array),indices:Array.from(point.index.array),uvs:Array.from(point.attributes.uv.array),material:{...state,wrapS,wrapT,filter}},pool).material;mesh.geometry=point;mesh.material=mat;renderer.setRenderTarget(target);renderer.render(scene,camera);const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,pixel);renderer.setRenderTarget(null);point.dispose();mat.dispose();return Array.from(pixel)};
window.sampleGrayFixture=(vertex)=>{const point=new THREE.PlaneGeometry(2,2),gray=127/255,colors=Array(12).fill(gray);if(vertex)point.setAttribute('color',new THREE.BufferAttribute(linearNativeColors(colors),3));const mat=createNativeSurfaceMaterial({id:'gray',source:'display-list',positions:Array.from(point.attributes.position.array),indices:Array.from(point.index.array),colors:vertex?colors:undefined,material:{...state,textureId:undefined,color:vertex?[1,1,1]:[gray,gray,gray],vertexColors:vertex}},pool).material;mesh.geometry=point;mesh.material=mat;renderer.setRenderTarget(null);renderer.render(scene,camera);const gl=renderer.getContext(),pixel=new Uint8Array(4);gl.readPixels(128,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);point.dispose();mat.dispose();return Array.from(pixel)};
window.disposeFixture=()=>{geometry.dispose();material.dispose();target.dispose();pool.dispose();renderer.dispose()};return Array.from(rows)};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent" });
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 280, height: 280 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setContent("<html><body style='margin:12px;background:#222'></body></html>");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const rows = await page.evaluate(source => (window as any).runFixture(source), source);
    assert.deepEqual(rows, [0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255], "top ROM row must appear at the top of a +T-down mapped surface");
    const temporary = await mkdtemp(join(tmpdir(), "mnsg-texture-gpu-"));
    await page.screenshot({ path: join(temporary, "asymmetric-orientation.png") });
    const sample = (u: number, v: number, wrapS: string, wrapT = "clamp", filter = "nearest") => page.evaluate(({ u, v, wrapS, wrapT, filter }) => (window as any).sampleFixture(u, v, wrapS, wrapT, filter), { u, v, wrapS, wrapT, filter });
    assert.deepEqual(await sample(.25, .25, "clamp"), [255, 0, 0, 255]);
    assert.deepEqual(await sample(1.25, .25, "repeat"), [255, 0, 0, 255]);
    assert.deepEqual(await sample(1.25, .25, "mirror"), [0, 255, 0, 255]);
    assert.deepEqual(await sample(1.25, .25, "clamp"), [0, 255, 0, 255]);
    assert.deepEqual(await sample(-.25, .25, "repeat"), [0, 255, 0, 255]);
    assert.deepEqual(await sample(-.25, .25, "mirror"), [255, 0, 0, 255]);
    assert.deepEqual(await sample(.25, 1.25, "clamp", "repeat"), [255, 0, 0, 255]);
    assert.deepEqual(await sample(.25, 1.25, "clamp", "mirror"), [0, 0, 255, 255]);
    assert.deepEqual(await sample(.75, .75, "clamp"), [0, 0, 0, 0], "transparent ROM texels must preserve alpha");
    const filtered = await sample(.5, .25, "clamp", "clamp", "linear");
    assert(Math.abs(filtered[0] - 128) <= 1 && Math.abs(filtered[1] - 128) <= 1 && filtered[2] === 0 && filtered[3] === 255);
    for (const vertex of [false, true]) {
      const gray = await page.evaluate(vertex => (window as any).sampleGrayFixture(vertex), vertex);
      assert(gray.slice(0, 3).every((value: number) => Math.abs(value - 127) <= 1) && gray[3] === 255, "display-space gray 127 must not brighten to 187");
    }
    assert.deepEqual(errors, []);
    console.log(`GPU fixture screenshot: ${join(temporary, "asymmetric-orientation.png")}`);
    await page.evaluate(() => (window as any).disposeFixture());
  } finally { await browser.close(); }
});

test("generated mapping requires complete finite native normals and trusted state, without static UVs", () => {
  const pool = new RoomTexturePool([source]);
  const generated: GeometryMesh = {
    ...surface, uvs: undefined, normals: [64 / 127, 0, 0, 64 / 127, 0, 0, 64 / 127, 0, 0],
    material: { ...surface.material!, texgen: { mode: "linear", basis: { kind: "editor-camera" }, scale: [1 / 1024, 1 / 1024], offset: [0, 0] } },
  };
  const fingerprint = JSON.stringify(generated);
  const accepted = createNativeSurfaceMaterial(generated, pool);
  assert.equal(accepted.textured, true);
  assert.equal(accepted.material.map, pool.get(source.id, sampler).texture);
  for (const normals of [undefined, [1, 0, 0], [...generated.normals!.slice(0, 8), NaN]]) {
    const fallback = createNativeSurfaceMaterial({ ...generated, normals }, pool);
    assert.equal(fallback.textured, false); assert.equal(fallback.material.map, null);
    assert.match(fallback.warning!, /complete verified native normals/); fallback.material.dispose();
  }
  for (const basis of [undefined, null, {}, { kind: "world", x: [0, 0], y: [0, 0, 0], source: "movemem" }]) {
    const fallback = createNativeSurfaceMaterial({ ...generated, material: { ...generated.material!, texgen: { ...generated.material!.texgen!, basis } as any } }, pool);
    assert.equal(fallback.textured, false); fallback.material.dispose();
  }
  const invalid = createNativeSurfaceMaterial({ ...generated, material: { ...generated.material!, texgen: { ...generated.material!.texgen!, scale: [NaN, 1] } } }, pool);
  assert.equal(invalid.textured, false); invalid.material.dispose();
  assert.equal(JSON.stringify(generated), fingerprint, "material creation cannot change coordinates or raw normals");
  accepted.material.dispose(); pool.dispose();
});

test("GPU native TEXGEN preserves raw normals, vertex interpolation, hierarchy and per-draw instance matrices", { skip: process.env.MNSG_GPU_TEST !== "1" }, async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bundle = await build({ stdin: { contents: `
import * as THREE from "three";
import {RoomTexturePool,createNativeSurfaceMaterial} from "./components/roomMaterials";
const renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,preserveDrawingBuffer:true});
renderer.setSize(256,256);renderer.setClearColor(0);document.body.appendChild(renderer.domElement);
const pixels=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)pixels.push(x*32+15,y*32+15,255,255);
const source={id:'native-palette',width:8,height:8,format:'fixture',rgbaBase64:btoa(String.fromCharCode(...pixels))};
const pool=new RoomTexturePool([source]);
const state={textureId:source.id,wrapS:'clamp',wrapT:'clamp',filter:'nearest',color:[1,1,1],opacity:1,alphaTest:0,vertexColors:false,lighting:false};
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,100);camera.position.z=10;
const scene=new THREE.Scene();
const sample=(x=128,y=128)=>{const gl=renderer.getContext(),p=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p]};
window.texgenSample=(options)=>{
 scene.clear();camera.position.fromArray(options.cameraPosition||[0,0,10]);camera.lookAt(...(options.cameraTarget||[0,0,0]));camera.rotateZ((options.cameraRoll||0)*Math.PI/180);camera.updateMatrixWorld();
 const g=new THREE.PlaneGeometry(8,8);
 const n=options.normals||[64/127,32/127,0];g.setAttribute('normal',new THREE.Float32BufferAttribute(Array.from({length:4},()=>n).flat(),3));
 // No fabricated UVs for generated surfaces.
 const data={id:'gen',source:'display-list',positions:[...g.attributes.position.array],indices:[...g.index.array],normals:[...g.attributes.normal.array],material:{...state,texgen:{mode:options.mode||'sphere',basis:options.basis||{kind:'world',x:[1,0,0],y:[0,1,0],source:'movemem'},scale:[1/1024,1/1024],offset:[0,0]}}};
 const before=JSON.stringify(data),built=createNativeSurfaceMaterial(data,pool),mesh=new THREE.Mesh(g,built.material),parent=new THREE.Group();
 parent.rotation.z=(options.rotation||0)*Math.PI/180;parent.scale.fromArray(options.scale||[1,1,1]);parent.add(mesh);scene.add(parent);
 renderer.render(scene,camera);const output=sample();
 const unchanged=JSON.stringify(data)===before;
 g.dispose();built.material.dispose();return {output,unchanged,textured:built.textured};
};
window.texgenShared=()=>{
 scene.clear();camera.rotation.set(0,0,0);camera.updateMatrixWorld();
 const g=new THREE.PlaneGeometry(.8,.8),n=[64/127,32/127,0];g.setAttribute('normal',new THREE.Float32BufferAttribute(Array(4).fill(n).flat(),3));
 const data={id:'shared',source:'display-list',positions:[...g.attributes.position.array],indices:[...g.index.array],normals:[...g.attributes.normal.array],material:{...state,texgen:{mode:'sphere',basis:{kind:'world',x:[1,0,0],y:[0,1,0],source:'movemem'},scale:[1/1024,1/1024],offset:[0,0]}}};
 const native=createNativeSurfaceMaterial(data,pool).material,left=new THREE.Mesh(g,native),right=new THREE.Mesh(g,native);
 left.position.x=-.5;right.position.x=.5;right.rotation.z=Math.PI/2;right.scale.set(.8,1.2,1);scene.add(left,right);
 renderer.render(scene,camera);const first=[sample(64,128),sample(192,128)];
 left.renderOrder=2;right.renderOrder=1;renderer.render(scene,camera);const reordered=[sample(64,128),sample(192,128)];
 const solid=new THREE.MeshBasicMaterial({color:0x00ff00,toneMapped:false});left.material=right.material=solid;renderer.render(scene,camera);const off=[sample(64,128),sample(192,128)];
 left.material=right.material=native;renderer.render(scene,camera);const restored=[sample(64,128),sample(192,128)];
 g.dispose();native.dispose();solid.dispose();return {first,reordered,off,restored};
};
window.texgenInterpolated=()=>{
 scene.clear();camera.rotation.set(0,0,0);camera.updateMatrixWorld();
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-3,-2,0,3,-2,0,0,4,0],3));
 g.setAttribute('normal',new THREE.Float32BufferAttribute([1,0,0,0,0,0,0,0,0],3));g.setIndex([0,1,2]);
 const data={id:'interpolated',source:'display-list',positions:[...g.attributes.position.array],indices:[0,1,2],normals:[...g.attributes.normal.array],material:{...state,texgen:{mode:'linear',basis:{kind:'world',x:[1,0,0],y:[0,1,0],source:'movemem'},scale:[1/1024,1/1024],offset:[0,0]}}};
 const m=createNativeSurfaceMaterial(data,pool).material;scene.add(new THREE.Mesh(g,m));renderer.render(scene,camera);const p=sample();g.dispose();m.dispose();return p;
};
window.texgenStatic=()=>{
 scene.clear();camera.rotation.set(0,0,0);camera.updateMatrixWorld();const g=new THREE.PlaneGeometry(8,8);
 g.setAttribute('uv',new THREE.Float32BufferAttribute(Array(4).fill([.3125,.1875]).flat(),2));
 const data={id:'static',source:'display-list',positions:[...g.attributes.position.array],indices:[...g.index.array],uvs:[...g.attributes.uv.array],material:state};
 const m=createNativeSurfaceMaterial(data,pool).material;scene.add(new THREE.Mesh(g,m));renderer.render(scene,camera);const p=sample();g.dispose();m.dispose();return p;
};
window.disposeGen=()=>{pool.dispose();renderer.dispose();renderer.forceContextLoss()};
`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent" });
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 280, height: 280 } });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setContent("<html><body style='margin:12px;background:#222'></body></html>");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const palette = (x: number, y: number) => [x * 32 + 15, y * 32 + 15, 255, 255];
    const nearPixel = (actual: number[], expected: number[]) => assert(actual.every((v, i) => Math.abs(v - expected[i]) <= 1), `${actual} != ${expected}`);
    const sample = async (options: Record<string, unknown>, x: number, y: number) => {
      const result = await page.evaluate(options => (window as any).texgenSample(options), options);
      assert.equal(result.textured, true); assert.equal(result.unchanged, true); nearPixel(result.output, palette(x, y));
    };
    await sample({}, 6, 5); // raw 64/127,32/127; normalization would address a different texel.
    await sample({ mode: "linear" }, 5, 4);
    await sample({ normals: [-128 / 127, 0, 0] }, 0, 4); // clamp signed native normal at -1.
    await sample({ mode: "linear", normals: [-128 / 127, 0, 0] }, 0, 4);
    await sample({ normals: [1, 0, 0] }, 7, 4);
    await sample({ mode: "linear", normals: [1, 0, 0] }, 7, 4);
    await sample({ basis: { kind: "world", x: [0, 0, 0], y: [0, 0, 0], source: "movemem" } }, 4, 4);
    await sample({ basis: { kind: "world", x: [0, 1, 0], y: [1, 0, 0], source: "native-reset" } }, 5, 6);
    await sample({ rotation: 90 }, 2, 6);
    await sample({ rotation: 45, scale: [3, .5, 1] }, 5, 6);
    await sample({ rotation: 45, scale: [3, .5, 1], mode: "linear" }, 5, 5);
    await sample({ cameraRoll: 31 }, 6, 5); // Literal world basis ignores view rotation.
    await sample({ cameraRoll: 31, basis: { kind: "editor-camera" } }, 6, 3);
    await sample({ cameraRoll: 31, mode: "linear", basis: { kind: "editor-camera" } }, 5, 3);
    await sample({ cameraPosition: [10, 0, 10], normals: [64 / 127, 32 / 127, 64 / 127], basis: { kind: "editor-camera" } }, 4, 5);
    // WASD-style eye+target translation retains the same camera basis.
    await sample({ cameraPosition: [2, 0, 10], cameraTarget: [2, 0, 0], basis: { kind: "editor-camera" } }, 6, 5);
    // Force a texel-boundary distinction between native signed-byte camera axes
    // and unquantized/modelView axes: native right bytes=(109,65,0).
    await sample({ cameraRoll: 31, normals: [-128 / 127, 90 / 127, 0], basis: { kind: "editor-camera" } }, 1, 7);
    const shared = await page.evaluate(() => (window as any).texgenShared());
    nearPixel(shared.first[0], palette(6, 5)); nearPixel(shared.first[1], palette(2, 6));
    assert.deepEqual(shared.reordered, shared.first); assert.deepEqual(shared.restored, shared.first);
    assert.deepEqual(shared.off, [[0, 255, 0, 255], [0, 255, 0, 255]]);
    nearPixel(await page.evaluate(() => (window as any).texgenInterpolated()), palette(5, 4));
    nearPixel(await page.evaluate(() => (window as any).texgenStatic()), palette(2, 1));
    assert.deepEqual(errors, []);
    const temporary = await mkdtemp(join(tmpdir(), "mnsg-texgen-gpu-"));
    await sample({ mode: "linear", rotation: 45, scale: [3, .5, 1] }, 5, 5);
    await page.screenshot({ path: join(temporary, "native-gen-linear.png") });
    console.log(`TEXGEN GPU fixture: ${join(temporary, "native-gen-linear.png")}`);
    await page.evaluate(() => (window as any).disposeGen());
  } finally { await browser.close(); }
});
