import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
	it("renders a labelled region with title and description", () => {
		render(<EmptyState title="Sin resultados" description="Prueba otro filtro" />);
		expect(screen.getByRole("region", { name: "Sin resultados" })).toBeInTheDocument();
		expect(screen.getByText("Prueba otro filtro")).toBeInTheDocument();
	});

	it("renders the optional action", () => {
		render(<EmptyState title="Vacío" action={<button type="button">Crear</button>} />);
		expect(screen.getByRole("button", { name: "Crear" })).toBeInTheDocument();
	});
});
