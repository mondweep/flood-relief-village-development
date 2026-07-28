import { Weights } from "../domain/weights.js";
import type { WeightsProvider } from "../application/ports.js";

/** In-memory fake of the WeightsProvider port; defaults to equal weights. */
export class StaticWeightsProvider implements WeightsProvider {
  constructor(private readonly weights: Weights = Weights.equal()) {}

  async get(): Promise<Weights> {
    return this.weights;
  }
}
