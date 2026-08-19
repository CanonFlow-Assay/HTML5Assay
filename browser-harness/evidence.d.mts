export interface EvidenceDigest {
  readonly algorithm: 'sha-256';
  readonly value: string;
}

export declare const canonicalEvidenceJson: (value: unknown) => string;
export declare const digestEvidence: (value: unknown) => EvidenceDigest;
