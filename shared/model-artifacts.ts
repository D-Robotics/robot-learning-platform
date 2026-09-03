export type ModelArtifactKind = 'source' | 'compiled';

/** Runtime placement is part of the artifact contract, not a UI hint. */
export type ModelArtifactRuntime = 'cpu-onnx' | 'bpu';

export type ModelArtifactWorkload =
  | 'locomotion'
  | 'perception'
  | 'navigation'
  | 'speech'
  | 'multimodal';

export type ModelArtifactFormat =
  | 'pytorch'
  | 'onnx'
  | 'bin'
  | 'hbm'
  | 'gguf'
  | 'unknown';

export interface ModelArtifactDescriptor {
  name: string;
  kind: ModelArtifactKind;
  format: ModelArtifactFormat;
  runtime?: ModelArtifactRuntime;
  workload?: ModelArtifactWorkload;
  /** CPU thread budget for deterministic control-loop inference. */
  threads?: number;
  /** Exact board targets declared by the artifact producer. */
  targetPlatforms?: string[];
  /** Normalized accelerator architecture, e.g. bernoulli2, bayes-e, nash. */
  acceleratorArchitecture?: string;
  /** Exact compiler/toolchain target. Prefer this over architecture inference. */
  toolchainTarget?: string;
  runtimePackage?: string;
}

export interface ModelPlatformTarget {
  family: string;
  platformId: string;
  acceleratorArchitecture: string;
  toolchainTarget: string;
  compiledFormats: ModelArtifactFormat[];
  runtimePackages: string[];
}

export type ModelCompatibilityStatus =
  | 'compatible'
  | 'requires-conversion'
  | 'needs-validation'
  | 'incompatible'
  | 'unknown-platform';

export interface ModelCompatibilityResult {
  status: ModelCompatibilityStatus;
  platform: ModelPlatformTarget | null;
  reasons: string[];
}
