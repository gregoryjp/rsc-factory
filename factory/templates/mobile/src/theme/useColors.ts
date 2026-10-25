import { useColorScheme } from "react-native";
import { type Colors, selectColors } from "./tokens";

export const useColors = (): Colors => selectColors(useColorScheme());
