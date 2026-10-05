import {expect,it} from 'vitest';
import {loadPartyDraft,savePartyDraft} from './partyDraft';
import {isShopOpen} from './openingHours';
import {PUBLIC_COPY} from './publicCopy';
it('restores only choices, not customer data or stale time',()=>{
  sessionStorage.clear();
  savePartyDraft('test',1,[{guestIndex:0,serviceId:'a',addonIds:[],staffId:null,startsAt:'old',phone:'secret'} as any]);
  expect(loadPartyDraft('test')).toEqual({partySize:1,items:[{guestIndex:0,serviceId:'a',addonIds:[],staffId:null}]});
  expect(sessionStorage.getItem('gf:party:test')).not.toContain('secret');
  sessionStorage.setItem('gf:party:test','{"partySize":500,"items":[]}');
  expect(loadPartyDraft('test')).toBeNull();
});
it('evaluates overnight hours in the shop timezone, not the browser',()=>{
  const hours={sat:{open:'18:00',close:'02:00'},sun:null};
  expect(isShopOpen(hours,'America/New_York',new Date('2026-09-20T05:00:00Z'))).toBe(true);
  expect(isShopOpen(hours,'America/New_York',new Date('2026-09-20T07:00:00Z'))).toBe(false);
});
it('provides every public copy key in all supported languages',()=>{
  for(const locale of ['en','zh-Hans','zh-Hant','es','vi','ko']){
    expect(Object.keys(PUBLIC_COPY[locale]!).sort()).toEqual(Object.keys(PUBLIC_COPY.en!).sort());
    expect(Object.values(PUBLIC_COPY[locale]!).every(Boolean)).toBe(true);
  }
});

it('shows closed during lunch even though the daily envelope is open',()=>{
 const hours={mon:{open:'09:00',close:'18:00',periods:[{open:'09:00',close:'12:00'},{open:'13:00',close:'18:00'}]}};
 expect(isShopOpen(hours,'America/New_York',new Date('2026-09-21T16:30:00Z'))).toBe(false);
 expect(isShopOpen(hours,'America/New_York',new Date('2026-09-21T17:00:00Z'))).toBe(true);
});
