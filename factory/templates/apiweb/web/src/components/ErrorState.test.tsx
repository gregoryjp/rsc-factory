import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {
	it("announces the error as an alert", () => {
		render(<ErrorState message="No se pudo cargar" />);
		expect(screen.getByRole("alert")).toHaveTextContent("No se pudo cargar");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("calls onRetry when the retry button is pressed", () => {
		const onRetry = vi.fn();
		render(<ErrorState message="Fallo" onRetry={onRetry} />);
		fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
