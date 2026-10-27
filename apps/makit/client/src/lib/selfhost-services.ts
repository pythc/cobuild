import { axiosForBackend } from './selfhost-http';
import type {
  AccountType, SearchUsersParams, SearchUsersResponse, BatchGetUsersResponse,
  SearchDepartmentsParams, SearchDepartmentsResponse,
  SearchChatsParams, SearchChatsResponse, BatchGetChatsResponse, UserProfileData,
} from '@lark-apaas/client-toolkit/tools/services';
export type { AccountType, SearchUsersParams, SearchUsersResponse, BatchGetUsersResponse,
  SearchDepartmentsParams, SearchDepartmentsResponse, SearchChatsParams, SearchChatsResponse,
  BatchGetChatsResponse, UserProfileData, UserInfo, SearchAvatar, DepartmentInfo, ChatInfo,
} from '@lark-apaas/client-toolkit/tools/services';
export type { MakitUserResolution as ConvertExternalContactResponse } from '@shared/selfhost-api';
import type { MakitUserResolution } from '@shared/selfhost-api';

async function post<T>(path: string, data: unknown, signal?: AbortSignal): Promise<T> {
  return (await axiosForBackend.post<T>(`/api/selfhost/${path}`, data, { signal })).data;
}
export class UserService {
  searchUsers(params: SearchUsersParams) { return post<SearchUsersResponse>('users/search', params); }
  listUsersByIds(userIds: string[]) { return post<BatchGetUsersResponse>('users/batch', { userIds }); }
  convertExternalContact(larkUserID: string) { return post<MakitUserResolution>('users/resolve', { larkUserID }); }
}
export class DepartmentService {
  searchDepartments(params: SearchDepartmentsParams) { return post<SearchDepartmentsResponse>('departments/search', params); }
}
export class ChatService {
  searchChats(params: SearchChatsParams) { return post<SearchChatsResponse>('chats/search', params); }
  listChatsByIds(chatIds: string[]) { return post<BatchGetChatsResponse>('chats/batch', { chatIds }); }
}
export class UserProfileService {
  getUserProfile(userId: string, accountType: AccountType, signal?: AbortSignal) {
    return post<UserProfileData>('users/profile', { userId, accountType }, signal);
  }
}
export function getAssetsUrl(path: string): string {
  // Historical attachment paths are resolved by the authenticated file adapter.
  return path;
}
