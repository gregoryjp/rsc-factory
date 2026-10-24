import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { PRODUCT_NAME } from "./config/product";

describe("App", () => {
	it("shows the product name as the main heading", () => {
		render(<App />);
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(PRODUCT_NAME);
	});
});
