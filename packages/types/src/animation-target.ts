declare const animationTargetIdBrand: unique symbol;

export type AnimationTargetIdValue = string & {
  readonly [animationTargetIdBrand]: true;
};
