import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach,vi } from 'vitest';
import {createElement} from 'react';
vi.mock('@number-flow/react',()=>({default:({value}:{value:number})=>createElement('span',null,value)}));

afterEach(() => cleanup());

Object.defineProperty(window,'matchMedia',{writable:true,value:(query:string)=>({matches:false,media:query,onchange:null,addListener:()=>{},removeListener:()=>{},addEventListener:()=>{},removeEventListener:()=>{},dispatchEvent:()=>false})});
if(!globalThis.ResizeObserver)globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
if(!Element.prototype.scrollIntoView)Element.prototype.scrollIntoView=()=>{};
