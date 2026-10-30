import type { RestFetcher } from "../../types/chat-service";
import { assertSuccess, parseJsonSafe } from "../apiHelpers";
import { heatmapRequestBody, parseHeatmapResponse, type HeatmapSquare } from "../exploreHeatmap";

export function createHeatmapMethods(fetchRest: RestFetcher, t: (key: string) => string) {
	return {
		/** Every city and neighbourhood Grindr marks with a rainbow flag. */
		async getHeatmapPlaces() {
			const response = await fetchRest("/v1/explore_heatmaps/all_locations");
			await assertSuccess(response, t("api.errors.load_heatmap"));
			return parseHeatmapResponse(await parseJsonSafe(response)).places;
		},

		/** The flags and heat points inside one square of the map. */
		async getHeatmap(square: HeatmapSquare) {
			const response = await fetchRest("/v1/explore_heatmaps", {
				method: "POST",
				body: heatmapRequestBody(square),
			});
			await assertSuccess(response, t("api.errors.load_heatmap"));
			return parseHeatmapResponse(await parseJsonSafe(response));
		},
	};
}
