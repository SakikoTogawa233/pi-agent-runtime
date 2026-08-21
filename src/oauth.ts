export interface OAuthModelLike {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
}

export interface ModelRegistryOAuthObserver<TModel extends OAuthModelLike> {
  find(provider: string, modelId: string): TModel | undefined;
  isUsingOAuth?(model: TModel): boolean;
}

export interface ModelRegistryOAuthObservation<TModel extends OAuthModelLike> {
  provider: string;
  modelId: string;
  api: string;
  selectedModel: TModel;
}

export function observeModelRegistryOAuth<TModel extends OAuthModelLike>(
  registry: ModelRegistryOAuthObserver<TModel>,
  provider: string,
  modelId: string,
): ModelRegistryOAuthObservation<TModel> {
  const selectedModel = registry.find(provider, modelId);
  if (selectedModel === undefined) {
    throw new Error(`Pi model not found in ModelRegistry: ${provider}/${modelId}`);
  }
  if (registry.isUsingOAuth === undefined) {
    throw new Error("ModelRegistry OAuth observation is unavailable");
  }
  if (!registry.isUsingOAuth(selectedModel)) {
    throw new Error(`Child Pi launch requires OAuth credentials for ${provider}/${modelId}`);
  }
  return { provider, modelId, api: selectedModel.api, selectedModel };
}
