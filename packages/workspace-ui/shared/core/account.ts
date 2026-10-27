export type AccountProfile = { id: string; email: string; display_name: string | null };
export type AccountState = {
  status: 'guest' | 'signed_in' | 'offline' | 'expired' | 'unavailable';
  user: AccountProfile | null;
  serverBaseUrl: string;
  storageAvailable: boolean;
  message: string;
};
