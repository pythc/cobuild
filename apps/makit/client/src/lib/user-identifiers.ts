export interface SelectableUserIdentity {
  userID?: string;
  larkUserID?: string;
  employeeID?: string;
}

export function selectableUserId(
  user: SelectableUserIdentity,
  accountType: 'apaas' | 'lark',
): string {
  if (accountType === 'lark') return user.employeeID || '';
  return user.userID || user.larkUserID || '';
}
