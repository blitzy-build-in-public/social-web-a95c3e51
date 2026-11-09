/** The auth route group: sign-in, check-email and the age gate in one stack (AAP 0.5.8). */
import { Stack } from 'expo-router';
import { colors } from '@tablemate/shared';

import { navigationHeaderOptions } from '../../src/ui';

const SCREEN_OPTIONS = {
  headerShown: true,
  // The band's fill, tint, title style, separator and back control all come from the one chrome
  // definition the root Stack and the tab navigator spread as well (`src/ui/NavigationHeader`), so no
  // navigator default and no second back control reaches a screen of this stack.
  ...navigationHeaderOptions('background'),
  contentStyle: { backgroundColor: colors.background },
};
// The age gate is the one pushed screen with no way back into the signed-in flow. The library's web
// header ignores `headerBackVisible`, which hides the native header's own back button alone, so the
// chrome's back control is replaced by nothing here.
const AGE_GATE = {
  title: 'Before you start',
  gestureEnabled: false,
  headerBackVisible: false,
  headerLeft: () => null,
};
export default function AuthLayout() {
  return (
    <Stack screenOptions={SCREEN_OPTIONS}>
      <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
      <Stack.Screen name="check-email" options={{ title: 'Check your email' }} />
      <Stack.Screen name="age-gate" options={AGE_GATE} />
    </Stack>
  );
}
