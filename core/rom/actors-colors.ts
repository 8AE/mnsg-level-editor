import type {GeometryTexture} from "../../shared/types";

export type ActorTextureColor="add-environment"|"environment"|"mix-environment"|"black";

/** RT64 color_combiner.h wrapClamp: final signed 9-bit combiner range. */
export function nativeCombinerClamp(value:number):number {
  const low=-.5-1/255,high=1.5+1/255,range=high-low;
  if(value<=low)value+=range;if(value>=high)value-=range;
  return Math.min(1,Math.max(0,value));
}

/** Immutable static color variant; source native pixels stay available unchanged. */
export function actorTextureColorVariant(source:GeometryTexture,mode:ActorTextureColor,environment:number[]):GeometryTexture {
  if(environment.length!==4||environment.some(n=>!Number.isFinite(n)||n<0||n>1))throw new Error("Invalid native environment color.");
  const pixels=Buffer.from(source.rgbaBase64,"base64");
  if(pixels.length!==source.width*source.height*4)throw new Error("Invalid native texture color source.");
  for(let at=0;at<pixels.length;at+=4)for(let channel=0;channel<3;channel++){
    const texel=pixels[at+channel]/255,env=environment[channel];
    const value=mode==="add-environment"?texel+env:mode==="environment"?env:mode==="mix-environment"?(env-texel)*environment[3]+texel:0;
    pixels[at+channel]=Math.round(nativeCombinerClamp(value)*255);
  }
  return {...source,id:`${source.id}:${mode}:${environment.join(",")}`,rgbaBase64:pixels.toString("base64")};
}

/** Final alpha is PRIM_A, so mapped pixel alpha must not multiply it again. */
export function actorPrimitiveAlphaTexture(source:GeometryTexture):GeometryTexture {
  const pixels=Buffer.from(source.rgbaBase64,"base64");if(pixels.length!==source.width*source.height*4)throw new Error("Invalid native texture alpha source.");
  for(let at=3;at<pixels.length;at+=4)pixels[at]=255;
  return {...source,id:`${source.id}:native-primitive-alpha`,rgbaBase64:pixels.toString("base64")};
}

/** FC1115FF/FFFDFE3B two-cycle, only for identical native UV/sampler domains. */
export function actorTextureProductVariant(first:GeometryTexture,second:GeometryTexture,primitive:number[]):GeometryTexture {
  if(first.width!==second.width||first.height!==second.height||primitive.length!==4||primitive.some(n=>!Number.isFinite(n)||n<0||n>1))throw new Error("Unaligned native two-texture composition.");
  const a=Buffer.from(first.rgbaBase64,"base64"),b=Buffer.from(second.rgbaBase64,"base64");if(a.length!==first.width*first.height*4||a.length!==b.length)throw new Error("Invalid native two-texture pixel source.");
  for(let at=0;at<a.length;at+=4){for(let channel=0;channel<3;channel++)a[at+channel]=Math.round(nativeCombinerClamp(a[at+channel]/255*b[at+channel]/255+primitive[channel])*255);a[at+3]=255;}
  return {...first,id:`${first.id}:${second.id}:native-product:${primitive.join(",")}`,rgbaBase64:a.toString("base64")};
}
