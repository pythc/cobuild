/** Browser contract for self-hosted identity, separate from business record IDs. */
export interface MakitSessionProfile {
  user_id: string;
  name: { zh_cn: string; en_us?: string };
  avatar: string;
  employeeId: string;
  openId: string;
  roles: string[];
}

export interface MakitDirectoryUser {
  userID: string;
  larkUserID: string;
  employeeID: string;
  name: { zh_cn: string };
  avatar: string;
  userType: '_employee';
  department: { departmentID: string; name: { zh_cn: string } };
}
export interface MakitUserResolution {
  data: { userInfo: { userID: string } };
}
