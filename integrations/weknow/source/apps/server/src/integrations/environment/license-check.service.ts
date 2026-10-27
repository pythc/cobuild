import { Injectable } from '@nestjs/common';
/** Core capabilities only. Paid modules are not included in the 110lab build. */
@Injectable()
export class LicenseCheckService {
  isValidEELicense(_key:string):boolean{return false;}
  hasFeature(_key:string,_feature:string,_plan?:string):boolean{return false;}
  getFeatures(_key:string):string[]{return [];}
  resolveFeatures(_key:string,_plan:string):string[]{return [];}
  resolveTier(_key:string,_plan:string):string{return '110lab';}
}
