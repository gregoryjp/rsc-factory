import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loading } from "./Loading";

describe("Loading", () => {
	it("announces a polite status with the default label", () => {
		render(<Loading />);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Cargando…");
		expect(status).toHaveAttribute("aria-live", "polite");
	});

	it("accepts a custom label", () => {
		render(<Loading label="Guardando" />);
		expect(screen.getByRole("status")).toHaveTextContent("Guardando");
	});
});
