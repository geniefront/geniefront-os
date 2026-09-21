import { expect, it } from 'vitest';
import { chooseServiceGuests, removePartyGuest } from './partyGuests';
import { loadPartyDraft, savePartyDraft } from './partyDraft';
it('selecting couples from either guest covers the same pair and adds a second guest when necessary', () => {
 expect(chooseServiceGuests(0,2,1,10,[],null)).toEqual({guests:[0,1],partySize:2});
 expect(chooseServiceGuests(1,2,2,10,[],null)).toEqual({guests:[0,1],partySize:2});
 expect(chooseServiceGuests(0,2,1,1,[],null)).toBeNull();
});
it('preserves shared coverage in drafts and removes the entire shared unit when a participant leaves', () => {
 const pair={guestIndex:0,guestIndices:[0,1],serviceId:'pair',addonIds:[],staffId:null};
 const solo={guestIndex:2,serviceId:'solo',addonIds:[],staffId:null};
 savePartyDraft('pair-test',3,[pair,solo]);expect(loadPartyDraft('pair-test')?.items).toEqual([pair,solo]);
 expect(removePartyGuest([pair,solo],1)).toEqual([{...solo,guestIndex:1}]);
});
