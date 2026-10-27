export type AIConnectionState = {
  mode: 'managed' | 'personal'; model: string; has_personal_key: boolean;
  personal_key_storage_available: boolean; serverBaseUrl?: string; signed_in?: boolean; email?: string;
};
export type AIConnectionInput = { mode: 'managed' | 'personal'; model: string; api_key?: string; serverBaseUrl?: string };
export interface AIConnectionRepository {
  get(): Promise<AIConnectionState>;
  save(value: AIConnectionInput): Promise<AIConnectionState>;
  removePersonal(): Promise<AIConnectionState>;
  models(): Promise<{ id: string; name: string }[]>;
  login?(): Promise<AIConnectionState>;
  logout?(): Promise<AIConnectionState>;
  cancelLogin?(): Promise<void>;
}
