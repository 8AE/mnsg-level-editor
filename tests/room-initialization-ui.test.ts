import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { build } from "esbuild";

// Bundle actual Once UI/providers: this catches missing context and the real read-only
// presentation path rather than mocking layout components or matching TSX source text.
let rendering: Promise<Record<string, string>> | undefined;
function rendered() {
  return (rendering ??= (async () => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        import React from "react";
        import {renderToStaticMarkup} from "react-dom/server";
        import {EditorTheme} from "./app/once-config";
        import Details from "./components/RoomInitializationDetails";
        import NativeInspector from "./components/RoomInspector";
        import AuthoredInspector from "./components/AuthoringInspector";
        import {emptyRoom} from "./components/authoringModel";
        const source={fileId:12,cpuAddress:0x8021102C,romOffset:0x5CC4FC,byteLength:36,sha256:"a".repeat(64)};
        const initialization={roomId:465,status:"world-metadata",context:{stage:7,localIndex:17,geometryGroup:4,geometryIndex:2},tableEntryRomOffset:0x123456,metadata:{source},actorDataFileId:918,reservedHalfword:0,reason:"Native room-loading inventory.",limits:["Actor-linked behavior remains separate."],loadCallback:{source,symbol:"func_8021102C",dependencyList:{source,orderedFileIds:[96,100,1137,401,338,643,364,644,35,448,405,32,407,345,43,515,54,27,61]}},geometry:{primarySource:source,resourceSource:source,resourceHalfwords:[127,240,241,253],coldLoadOrder:[127,240,241,253]}};
        const render=element=>renderToStaticMarkup(React.createElement(EditorTheme,null,element));
        const details=props=>render(React.createElement(Details,props));
        const room=emptyRoom(620,"Clone",465);
        const v={position:{x:0,y:0,z:0},uv:[0,0],color:[255,255,255,255]};
        room.actors=[{id:"actor-1",prototypeId:"native-actor",position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},parameters:[0,0,0]}];
        room.meshes=[{id:"mesh-1",vertices:[v,{...v,position:{x:10,y:0,z:0}},{...v,position:{x:0,y:10,z:0}}],indices:[0,1,2],materialId:"material-1"}];
        room.materials=[{id:"material-1",sourceMaterialId:"native-material"}];
        room.doors=[{id:"door-1",position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},dimensions:{x:80,y:120,z:40},activation:"interact",destination:{roomId:620,entranceId:room.entrances[0].id}}];
        const fail=()=>{throw new Error("Read-only presentation mutated the project");};
        const props={room,initialization,catalog:{actorPrototypes:[{id:"native-actor",name:"Native actor"}],materials:[{id:"native-material",name:"Native material"}],skyboxes:[],surfaces:[]},selected:null,geometrySelection:null,disabled:false,visualsPending:false,destinationRooms:[{id:620,name:"Clone"}],loadEntrances:async()=>room.entrances,referencedEntrances:new Set(),externalEntranceIds:new Set(),nativeEntranceIds:new Set(),followCollision:false,onChange:fail,onSelect:fail,onGeometrySelect:fail,onFrame:fail,onRevertSaved:fail,onRestoreNative:fail,onFollowCollision:fail};
        const authored=changes=>render(React.createElement(AuthoredInspector,{...props,...changes}));
        const before=JSON.stringify({room,initialization});
        const output={
          ordinary:details({initialization}),
          orderedDuplicates:details({initialization:{...initialization,loadCallback:{...initialization.loadCallback,dependencyList:{...initialization.loadCallback.dependencyList,orderedFileIds:[61,35,61]}}}}),
          special:details({initialization:{...initialization,roomId:540,status:"special-geometry-alias",metadata:undefined,loadCallback:undefined,actorDataFileId:undefined,reason:"Special geometry alias.",geometry:{...initialization.geometry,ordinaryGeometryAliasRoomId:465}}}),
          sample:details({sample:true}),missing:details({}),
          native:render(React.createElement(NativeInspector,{room:{id:465,name:"House",meshes:[],initialization},translation:{x:0,y:0,z:0},modified:false,busy:false,sample:false,sharedImpacts:[],onChange:fail,onReset:fail,onFrame:fail})),
          authored:authored({}),
          replacement:authored({room:{...room,id:465,kind:"replacement"}}),
          actor:authored({selected:"actor-1"}),door:authored({selected:"door:door-1"}),
          entrance:authored({selected:"entrance:"+room.entrances[0].id}),
          mesh:authored({geometrySelection:{mode:"mesh",meshId:"mesh-1"}})
        };
        if(JSON.stringify({room,initialization})!==before) throw new Error("Presentation changed persisted data");
        console.log(JSON.stringify(output));
      `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      loader: { ".css": "empty", ".scss": "empty" },
    });
    const result = spawnSync(process.execPath, [], {
      input: bundle.outputFiles[0].text,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  })());
}
const fileOrder = (html: string, id: string) => {
  const list = html.match(
    new RegExp(`<ol[^>]*data-testid="${id}"[^>]*>(.*?)</ol>`),
  );
  assert.ok(list, id);
  return [...list[1].matchAll(/<code>File (\d+)<\/code>/g)].map((match) =>
    Number(match[1]),
  );
};

test("read-only initialization preserves ordered resources separately from geometry and collapses technical sources", async () => {
  const output = await rendered();
  assert.deepEqual(
    fileOrder(output.ordinary, "initialization-resource-order"),
    [
      96, 100, 1137, 401, 338, 643, 364, 644, 35, 448, 405, 32, 407, 345, 43,
      515, 54, 27, 61,
    ],
  );
  assert.deepEqual(
    fileOrder(output.ordinary, "initialization-geometry-order"),
    [127, 240, 241, 253],
  );
  assert.deepEqual(
    fileOrder(output.orderedDuplicates, "initialization-resource-order"),
    [61, 35, 61],
    "never sort or deduplicate native load order",
  );
  assert.match(output.ordinary, /Room initialization/);
  assert.match(output.ordinary, /CPU address/);
  assert.match(output.ordinary, /0x8021102C/);
  assert.match(output.ordinary, /0x5CC4FC/);
  assert.doesNotMatch(
    output.ordinary,
    /<details[^>]*\sopen(?:=|>|\s)|<input|<button|<select/,
  );
  assert.match(output.native, /data-testid="room-initialization"/);
});

test("special geometry alias and missing/sample inventory do not fabricate empty events or callback completion", async () => {
  const output = await rendered();
  assert.match(output.special, /No ordinary-world metadata/);
  assert.match(output.special, /Special-scene setup has not been recovered/);
  assert.match(output.special, /Geometry aliases ordinary room 465/);
  assert.doesNotMatch(
    output.special,
    /initialization-resource-order|No events|no-op/i,
  );
  assert.match(
    output.sample,
    /procedural sample has no native room initialization data/,
  );
  assert.match(output.missing, /inventory is not available/);
  assert.doesNotMatch(
    output.sample + output.missing,
    /initialization-resource-order|CPU address/,
  );
});

test("authored initialization identifies donor465 and appears only at room level", async () => {
  const output = await rendered();
  for (const html of [output.authored, output.replacement]) {
    assert.match(html, /Template room 465 provides initialization/);
    assert.doesNotMatch(html, /Template room 620 provides initialization/);
  }
  for (const view of ["actor", "door", "entrance", "mesh"])
    assert.doesNotMatch(
      output[view],
      /data-testid="room-initialization"/,
      view,
    );
});
