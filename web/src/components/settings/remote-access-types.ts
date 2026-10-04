export interface RemoteAccessSettings {
  enabled: boolean;
  tunnelPort: number;
  tunnelBindAddress: string;
  teamDomain: string | null;
  audience: string | null;
  ownerEmails: string[];
  allowRequesters: boolean;
  restartRequired: boolean;
  running: {
    enabled: boolean;
    tunnelPort: number;
    tunnelBindAddress: string;
    listening: boolean;
    tunnelUrl: string;
  };
  editable: boolean;
  via: "local" | "tunnel";
  warnings: string[];
}

export interface RemoteAccessCheck {
  ok: boolean;
  listening: boolean;
  tunnelUrl: string | null;
  issuer: string | null;
  keyCount: number | null;
  keysError: string | null;
  problems: string[];
}

export interface RemoteAccessForm {
  enabled: boolean;
  tunnelPort: number;
  teamDomain: string;
  audience: string;
  ownerEmails: string;
  allowRequesters: boolean;
}
