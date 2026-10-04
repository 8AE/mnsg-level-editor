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
