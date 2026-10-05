import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import type { GeometryMesh, GeometryTexture, RoomData } from "../shared/types";
import {
  bindNativeDualAttributes,
  createNativeSurfaceMaterial,
  roomTextureCoverage,
  hasNativeDualTextureCoordinates,
  hasNativeTextureCoordinates,
  hasNativeNormals,
  RoomTexturePool,
} from "../components/roomMaterials";

const sampler = { wrapS: "repeat", wrapT: "clamp", filter: "linear" } as const;
const pixels = [
  32, 80, 160, 255, 224, 192, 64, 255, 64, 144, 224, 255, 176, 48, 112, 255,
];
const images: GeometryTexture[] = [
  {
    id: "first",
    width: 2,
    height: 2,
    format: "synthetic RGBA",
    rgbaBase64: Buffer.from(pixels).toString("base64"),
  },
  {
    id: "second",
    width: 2,
    height: 2,
    format: "synthetic RGBA",
    rgbaBase64: Buffer.from([
      208, 64, 96, 255, 48, 224, 176, 255, 128, 176, 32, 255, 80, 112, 240, 255,
    ]).toString("base64"),
  },
];
const alternateImage: GeometryTexture = {
  id: "alternate-second",
  width: 2,
  height: 2,
  format: "synthetic RGBA",
  rgbaBase64: Buffer.from(Array(4).fill([48, 112, 192, 255]).flat()).toString(
    "base64",
  ),
};
const surface: GeometryMesh = {
  id: "two-sample-fixture",
  source: "display-list",
  positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
  indices: [0, 1, 2, 2, 1, 3],
  uvs: Array(4).fill([0.5, 0.5]).flat(),
  secondaryUvs: Array(4)
    .fill([0.5 - 7.5 / 64, 0.5 + 1.25 / 32])
    .flat(),
  colors: Array(4)
    .fill([127 / 255, 83 / 255, 211 / 255])
    .flat(),
  material: {
    ...sampler,
    textureId: "first",
    color: [0, 0, 0],
    opacity: 208 / 255,
    alphaTest: 0,
    vertexColors: true,
    lighting: false,
    dualTexture: {
      ...sampler,
      wrapS: "mirror",
      wrapT: "repeat",
      textureId: "second",
      mode: "multiply-shade-primitive-alpha",
      opaqueFirstCycle: true,
    },
  },
};

test("dual materials isolate raw sampler caches, preserve encoded shade and dispose shared uploads once", () => {
  const before = JSON.stringify({ images, surface });
  const pool = new RoomTexturePool(images);
  const single = pool.get("first", sampler).texture;
  const native = createNativeSurfaceMaterial(surface, pool);
  assert.equal(native.textured, true);
  assert.equal(native.warning, undefined);
  assert.equal(native.material.map!.colorSpace, THREE.NoColorSpace);
  assert.equal(single.colorSpace, THREE.SRGBColorSpace);
  assert.notEqual(single, native.material.map);
  assert.equal(
    single.image.data,
    (native.material.map as THREE.DataTexture).image.data,
  );
  assert.equal(
    pool.get("first", sampler, THREE.NoColorSpace).texture,
    native.material.map,
  );
  assert.equal(native.material.alphaTest, 0);
  assert.equal(native.material.opacity, 208 / 255);
  assert.equal(native.material.vertexColors, false);
  assert.deepEqual(
    native.material.color.toArray(),
    [1, 1, 1],
    "primitive RGB is not part of this rule",
  );
  const geometry = new THREE.BufferGeometry();
  bindNativeDualAttributes(geometry, surface);
  assert(
    Math.abs(geometry.getAttribute("mnsgEncodedShade").getX(0) - 127 / 255) <
      1e-7,
  );
  assert.deepEqual(
    Array.from(geometry.getAttribute("mnsgSecondaryUv").array),
    surface.secondaryUvs,
  );
  const rawSecond = pool.get(
    "second",
    surface.material!.dualTexture!,
    THREE.NoColorSpace,
  ).texture;
  let disposed = 0;
  for (const texture of [single, native.material.map!, rawSecond])
    texture.addEventListener("dispose", () => disposed++);
  native.material.dispose();
  geometry.dispose();
  pool.dispose();
  pool.dispose();
  assert.equal(disposed, 3);
  assert.equal(JSON.stringify({ images, surface }), before);
});

test("missing or unproven second appearance fails closed and cannot claim primary-only coverage", () => {
  const invalid: GeometryMesh[] = [
    { ...surface, secondaryUvs: undefined },
    { ...surface, secondaryUvs: [NaN, ...surface.secondaryUvs!.slice(1)] },
    { ...surface, colors: undefined },
    {
      ...surface,
      material: {
        ...surface.material!,
        dualTexture: {
          ...surface.material!.dualTexture!,
          opaqueFirstCycle: false,
        } as never,
      },
    },
    {
      ...surface,
      material: {
        ...surface.material!,
        dualTexture: {
          ...surface.material!.dualTexture!,
          mode: "unknown",
        } as never,
      },
    },
    {
      ...surface,
      material: {
        ...surface.material!,
        dualTexture: {
          ...surface.material!.dualTexture!,
          textureId: "missing",
        },
      },
    },
    {
      ...surface,
      material: {
        ...surface.material!,
        dualTexture: {
          ...surface.material!.dualTexture!,
          wrapS: "unknown",
        } as never,
      },
    },
    { ...surface, material: { ...surface.material!, alphaTest: 0.5 } },
  ];
  for (const key of ["uvs", "secondaryUvs", "colors"] as const) {
    const sparse = { ...surface, [key]: new Array(surface[key]!.length) };
    assert.equal(
      hasNativeDualTextureCoordinates(sparse),
      false,
      `Sparse${key} cannot establish complete native attributes`,
    );
    const geometry = new THREE.BufferGeometry();
    bindNativeDualAttributes(geometry, sparse);
    assert.equal(geometry.hasAttribute("mnsgSecondaryUv"), false);
    assert.equal(geometry.hasAttribute("mnsgEncodedShade"), false);
    geometry.dispose();
    invalid.push(sparse);
  }
  assert.equal(
    hasNativeTextureCoordinates({
      ...surface,
      uvs: new Array(surface.uvs!.length),
    }),
    false,
  );
  assert.equal(
    hasNativeNormals({
      ...surface,
      normals: new Array(surface.positions.length),
    }),
    false,
  );
  for (const mesh of invalid) {
    const pool = new RoomTexturePool(images);
    const result = createNativeSurfaceMaterial(mesh, pool);
    assert.equal(result.textured, false);
    assert.equal(result.material.map, null);
    assert(result.warning);
    assert.equal(
      roomTextureCoverage({ meshes: [mesh], textures: images } as RoomData)
        .textured,
      0,
    );
    result.material.dispose();
    pool.dispose();
  }
  for (const broken of [
    { ...images[1], rgbaBase64: "AA==" },
    {
      ...images[1],
      rgbaBase64: Buffer.from(
        pixels.map((v, i) => (i === 3 ? 254 : v)),
      ).toString("base64"),
    },
  ]) {
    const pool = new RoomTexturePool([images[0], broken]);
    const result = createNativeSurfaceMaterial(surface, pool);
    assert.equal(result.textured, false);
    assert.equal(result.material.map, null);
    assert(result.warning);
    result.material.dispose();
    pool.dispose();
  }
  const pool = new RoomTexturePool(images);
  const lit = createNativeSurfaceMaterial(
    { ...surface, material: { ...surface.material!, lighting: true } },
    pool,
  );
  assert.equal(lit.textured, true);
  assert.match(lit.warning!, /white shade approximation/);
  lit.material.dispose();
  pool.dispose();
});

// Independent CPU sampler oracle: interpolate encoded channel bytes, then multiply.
function sample(
  image: GeometryTexture,
  uv: number[],
  state: typeof sampler | NonNullable<GeometryMesh["material"]>["dualTexture"],
): number[] {
  const bytes = Buffer.from(image.rgbaBase64, "base64");
  function address(i: number, n: number, wrap: string) {
    if (wrap === "clamp") return Math.max(0, Math.min(n - 1, i));
    if (wrap === "repeat") return ((i % n) + n) % n;
    const period = ((i % (2 * n)) + 2 * n) % (2 * n);
    return period < n ? period : 2 * n - 1 - period;
  }
  const pixel = (x: number, y: number, c: number) =>
    bytes[
      (address(y, image.height, state!.wrapT) * image.width +
        address(x, image.width, state!.wrapS)) *
        4 +
        c
    ];
  if (state!.filter === "nearest")
    return [0, 1, 2].map((c) =>
      pixel(
        Math.floor(uv[0] * image.width),
        Math.floor(uv[1] * image.height),
        c,
      ),
    );
  const x = uv[0] * image.width - 0.5,
    y = uv[1] * image.height - 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  return [0, 1, 2].map(
    (c) =>
      (pixel(ix, iy, c) * (1 - fx) + pixel(ix + 1, iy, c) * fx) * (1 - fy) +
      (pixel(ix, iy + 1, c) * (1 - fx) + pixel(ix + 1, iy + 1, c) * fx) * fy,
  );
}

test(
  "GPU dual maps filter independently in encoded space, interpolate encoded shade and restore shared instance textures",
  { skip: process.env.MNSG_GPU_TEST !== "1" },
  async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
import * as THREE from 'three';
import {RoomTexturePool,createNativeSurfaceMaterial,bindNativeDualAttributes,linearNativeColors} from './components/roomMaterials';
window.runDual=(images,base,cases,alternateImage)=>{
 const renderer=new THREE.WebGLRenderer({alpha:true,antialias:false,preserveDrawingBuffer:true});
 renderer.setSize(32,16);renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
 document.body.appendChild(renderer.domElement);
 const camera=new THREE.OrthographicCamera(-2,2,1,-1,.1,10);camera.position.z=2;
 const scene=new THREE.Scene(),pool=new RoomTexturePool([...images,alternateImage]),gl=renderer.getContext();
 const makeGeometry=data=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setIndex(data.indices);g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));g.setAttribute('color',new THREE.BufferAttribute(linearNativeColors(data.colors),3));bindNativeDualAttributes(g,data);return g;};
 const read=x=>{const p=new Uint8Array(4);gl.readPixels(x,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p);};
 const answers=[];
 for(const item of cases){
  const data={...base,uvs:Array(4).fill(item.first).flat(),secondaryUvs:Array(4).fill(item.second).flat(),material:{...base.material,filter:item.primaryFilter||'linear',dualTexture:{...base.material.dualTexture,filter:item.secondaryFilter||'linear'}}};
  const result=createNativeSurfaceMaterial(data,pool);result.material.blending=THREE.NoBlending;
  const geometry=makeGeometry(data),mesh=new THREE.Mesh(geometry,result.material);scene.add(mesh);renderer.render(scene,camera);answers.push(read(16));scene.remove(mesh);geometry.dispose();result.material.dispose();
 }
 // Same material across two meshes: coordinates are per-geometry, not mutable uniforms.
 const data={...base,uvs:Array(4).fill([.25,.25]).flat(),secondaryUvs:Array(4).fill([.75,.75]).flat()};
 const native=createNativeSurfaceMaterial(data,pool).material;native.blending=THREE.NoBlending;
 const a=new THREE.Mesh(makeGeometry(data),native),b=new THREE.Mesh(makeGeometry({...data,uvs:Array(4).fill([.75,.25]).flat(),secondaryUvs:Array(4).fill([.25,.75]).flat()}),native);a.position.x=-1;b.position.x=1;scene.add(a,b);
 renderer.render(scene,camera);const before=[read(8),read(24)];
 const solid=new THREE.MeshBasicMaterial({color:0x55aa99,toneMapped:false});a.material=b.material=solid;renderer.render(scene,camera);const off=[read(8),read(24)];a.material=b.material=native;renderer.render(scene,camera);const restored=[read(8),read(24)];
 // Reused GPU program with a different second map must upload each material's own sampler.
 const alternateData={...data,material:{...data.material,dualTexture:{...data.material.dualTexture,textureId:alternateImage.id}}};
 const alternate=createNativeSurfaceMaterial(alternateData,pool).material;alternate.blending=THREE.NoBlending;
 b.material=alternate;renderer.render(scene,camera);const differentMaps=[read(8),read(24)];b.material=native;alternate.dispose();
 // Varying shade at the pixel center must interpolate the encoded bytes themselves.
 scene.remove(a,b);const varying={...data,colors:[.1,.2,.3,.9,.8,.7,.1,.2,.3,.9,.8,.7]};
 const shadeMesh=new THREE.Mesh(makeGeometry(varying),native);scene.add(shadeMesh);renderer.render(scene,camera);const shade=read(16);
 for(const g of [a.geometry,b.geometry,shadeMesh.geometry])g.dispose();native.dispose();solid.dispose();pool.dispose();renderer.dispose();renderer.forceContextLoss();
 return{answers,before,off,restored,differentMaps,shade};
};`,
      },
      bundle: true,
      write: false,
      format: "iife",
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const cases = [
        { first: [0.5, 0.5], second: [0.5 - 7.5 / 64, 0.5 + 1.25 / 32] },
        { first: [-0.12, 0.6], second: [1.17, -0.15] },
        { first: [0.99, -0.1], second: [-0.2, 1.14] },
        {
          first: [1.23, 1.14],
          second: [2.1, 0.6],
          primaryFilter: "nearest",
          secondaryFilter: "linear",
        },
        {
          first: [0.52, 0.43],
          second: [0.73, 0.55],
          primaryFilter: "linear",
          secondaryFilter: "nearest",
        },
        { first: [0.5, 0.25], second: [0.5, 0.25] },
      ];
      const result = await page.evaluate(
        ({ images, surface, cases, alternateImage }) =>
          (window as any).runDual(images, surface, cases, alternateImage),
        { images, surface, cases, alternateImage },
      );
      const shade = [127, 83, 211];
      function oracle(
        first: number[],
        second: number[],
        primaryFilter = "linear",
        secondaryFilter = "linear",
        encodedShade = shade,
      ) {
        const a = sample(images[0], first, {
            ...sampler,
            filter: primaryFilter as "linear",
          }),
          b = sample(images[1], second, {
            ...surface.material!.dualTexture!,
            filter: secondaryFilter as "linear",
          });
        return a.map((value, c) =>
          Math.round((value * b[c] * encodedShade[c]) / (255 * 255)),
        );
      }
      cases.forEach((item, i) => {
        const expected = oracle(
          item.first,
          item.second,
          item.primaryFilter,
          item.secondaryFilter,
        );
        expected.forEach((value, c) =>
          assert(
            Math.abs(result.answers[i][c] - value) <= 2,
            `case${i} channel${c}: GPU ${result.answers[i][c]} vs encoded oracle ${value}`,
          ),
        );
        assert.equal(
          result.answers[i][3],
          208,
          "final alpha comes only from primitive opacity",
        );
      });
      const independent = oracle([0.5, 0.25], [0.5, 0.25]);
      const baked = [0, 1, 2].map((c) =>
        Math.round(
          (((pixels[c] * Buffer.from(images[1].rgbaBase64, "base64")[c] +
            pixels[4 + c] *
              Buffer.from(images[1].rgbaBase64, "base64")[4 + c]) /
            2) *
            shade[c]) /
            (255 * 255),
        ),
      );
      assert(
        independent.some((v, c) => Math.abs(v - baked[c]) >= 5),
        "edge fixture distinguishes filtering a baked product",
      );
      assert.deepEqual(result.restored, result.before);
      assert.notDeepEqual(result.off, result.before);
      [
        oracle([0.25, 0.25], [0.75, 0.75]),
        oracle([0.75, 0.25], [0.25, 0.75]),
      ].forEach((expected, i) =>
        expected.forEach((v, c) =>
          assert(Math.abs(result.before[i][c] - v) <= 2),
        ),
      );
      assert.deepEqual(
        result.differentMaps[0],
        result.before[0],
        "Other instances retain the original second map",
      );
      const firstSample = sample(images[0], [0.75, 0.25], sampler),
        secondSample = sample(
          alternateImage,
          [0.25, 0.75],
          surface.material!.dualTexture,
        );
      firstSample
        .map((v, c) =>
          Math.round((v * secondSample[c] * shade[c]) / (255 * 255)),
        )
        .forEach((v, c) =>
          assert(
            Math.abs(result.differentMaps[1][c] - v) <= 2,
            "Shared program must use the alternate material's second sampler",
          ),
        );
      assert.notDeepEqual(result.differentMaps[1], result.before[1]);
      // Pixel16 spans x=0.0625 => encoded left/right interpolation t=0.53125.
      const interpolated = [0.1, 0.2, 0.3].map(
        (left, c) =>
          (left * (1 - 0.53125) + [0.9, 0.8, 0.7][c] * 0.53125) * 255,
      );
      oracle(
        [0.25, 0.25],
        [0.75, 0.75],
        "linear",
        "linear",
        interpolated,
      ).forEach((v, c) => assert(Math.abs(result.shade[c] - v) <= 2));
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
