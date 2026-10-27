/** 110lab community-only boundary. No commercial modules or licence requests. */
import React from "react";
import { atom } from "jotai";

export const Feature = Object.freeze(
  Object.fromEntries(
    [
      "AI",
      "API_KEYS",
      "ATTACHMENT_INDEXING",
      "AUDIT_LOGS",
      "BASES",
      "COMMENT_RESOLUTION",
      "CONFLUENCE_IMPORT",
      "DOCX_EXPORT",
      "DOCX_IMPORT",
      "PAGE_VERIFICATION",
      "PDF_IMPORT",
      "PERSONAL_SPACES",
      "PUBLIC_SPACE_APPEARANCE",
      "SECURITY_SETTINGS",
      "TEMPLATES",
    ].map((name) => [name, name]),
  ),
);
export function useHasFeature(_feature: string): boolean {
  return false;
}
export function useUpgradeLabel(): undefined {
  return undefined;
}
export const entitlementAtom = atom({ features: [] as string[] });
export function useEntitlements(): any {
  return { data: { features: [] } };
}
export const useRedirectToCloudSelect = () => {};
export const useTrialEndAction = () => {};
export const PosthogUser = () => null;
export const PageVerificationBadge = (_props: any) => null;
export const PageVerificationMenuItem = (_props: any) => null;
export const PageVerificationModal = (_props: any) => null;
export const PageShareModal = (_props: any) => null;
export const ResolveComment = (_props: any) => null;
export const MfaSettings = (_props: any) => null;
export const EditorAiMenu = (_props: any) => null;
export const BaseView = (_props: any) => null;
export const BaseTableSkeleton = (_props: any) => null;
export const ChatInput = (_props: any) => null;
export const useBaseQuery = (_id?: any): any => ({
  data: null,
  isLoading: false,
  isError: false,
});
export const usePersonalSpaceQuery = (_enabled?: any): any => ({ data: null });
export const useConvertPageToBaseMutation = (): any => ({
  mutateAsync: () => Promise.reject(new Error("该功能尚未开放")),
});
export const useResolveCommentMutation = (): any => ({
  mutateAsync: () => Promise.reject(new Error("该功能尚未开放")),
});
export const hintVectorCache = async (..._args: any[]) => {};
export const getApiKeys = async (..._args: any[]): Promise<any> => ({
  items: [],
});
export const getBilling = getApiKeys;
export const getBillingPlans = getApiKeys;
export const getLicenseInfo = getApiKeys;
export const getSsoProviders = getApiKeys;
export const getAuditLogs = getApiKeys;
export const getVerificationList = getApiKeys;
export const getScimTokens = getApiKeys;
export type IApiKey = any;
export type IAuthProvider = any;
export type ChatAttachment = any;
export type PageMention = any;
export function getHostnameUrl(_hostname: string): string {
  return window.location.origin;
}
export function exchangeTokenRedirectUrl(..._data: any[]): string {
  return "/login";
}
export default function UnavailableComponent(_props: any): React.ReactNode {
  return null;
}
export function useTrial(): any {
  return { isTrial: false, trialDaysLeft: 0, isExpired: false };
}
