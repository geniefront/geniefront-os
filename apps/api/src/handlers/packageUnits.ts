import {AppError,ERROR_CODES} from '@gf/contracts';
import {parsePackageUnitRanges,packageRangeCount,takePackageUnits,type PackageUnitRange} from '@gf/payroll';
export interface PackageUnitState {
 total_sessions:number;remaining_sessions:number;reserved_sessions:number;available_units:string;
 purchase_snapshot?:{unitAllocationVersion?:number}|null;
}
export function availablePackageUnits(asset:PackageUnitState):PackageUnitRange[]{
 if(asset.total_sessions===0)return [];
 let ranges=parsePackageUnitRanges(asset.available_units,asset.total_sessions);
 const available=asset.remaining_sessions-asset.reserved_sessions;
 // Old seed/import assets retain quantity, without claiming historical unit identities.
 if(!ranges.length&&available>0&&asset.purchase_snapshot?.unitAllocationVersion!==2)
   ranges=[[asset.total_sessions-asset.remaining_sessions+asset.reserved_sessions,asset.total_sessions]];
 if(packageRangeCount(ranges)!==available)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'package_unit_cache_inconsistent'}});
 return ranges;
}
export function allocatePackageUse(asset:PackageUnitState,price:number,units:number){
 if(asset.total_sessions===0)return {taken:[] as PackageUnitRange[],remaining:[] as PackageUnitRange[],valueCents:0};
 return takePackageUnits(price,asset.total_sessions,availablePackageUnits(asset),units);
}
