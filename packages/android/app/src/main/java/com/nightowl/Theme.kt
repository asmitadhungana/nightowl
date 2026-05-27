package com.nightowl

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * NightOwl "Bold Midnight" theme — deep indigo surfaces + a vivid violet accent.
 * A single dark scheme (it's a bedtime app; no light variant). Setting the full
 * surfaceContainer* ramp is what makes Material3 Cards render in our indigo
 * instead of the default gray.
 */

private val Violet = Color(0xFF8B5CF6)
private val VioletBright = Color(0xFFB39DFB)
private val Indigo = Color(0xFF12102E)
private val Lavender = Color(0xFFECE9FB)
private val LavenderMuted = Color(0xFFB8B2DC)

/** Semantic status colors (outside the M3 scheme) — used by the hero + indicators. */
val NightOwlArmed = Color(0xFF49E08A)
val NightOwlPaused = Color(0xFFF4B860)
val NightOwlAlert = Color(0xFFFF6B7A)

/** Indigo → violet gradient for the hero status banner. */
val NightOwlHeroGradient: Brush = Brush.linearGradient(
    colors = listOf(Color(0xFF221C52), Color(0xFF5B3CC4), Color(0xFF7C4DEA)),
)

private val NightOwlColors = darkColorScheme(
    primary = Violet,
    onPrimary = Color(0xFF160E33),
    primaryContainer = Color(0xFF332A6B),
    onPrimaryContainer = Color(0xFFE7DEFF),
    secondary = VioletBright,
    onSecondary = Color(0xFF1B1340),
    secondaryContainer = Color(0xFF2C2658),
    onSecondaryContainer = Color(0xFFE7DEFF),
    tertiary = Color(0xFFF2A9D0),
    onTertiary = Color(0xFF3A0C2A),
    background = Indigo,
    onBackground = Lavender,
    surface = Indigo,
    onSurface = Lavender,
    surfaceVariant = Color(0xFF2A2556),
    onSurfaceVariant = LavenderMuted,
    surfaceTint = Violet,
    surfaceContainerLowest = Color(0xFF0D0B24),
    surfaceContainerLow = Color(0xFF171441),
    surfaceContainer = Color(0xFF1C1849),
    surfaceContainerHigh = Color(0xFF231E55),
    surfaceContainerHighest = Color(0xFF2A2462),
    error = NightOwlAlert,
    onError = Color(0xFF3A0A12),
    errorContainer = Color(0xFF5C1A24),
    onErrorContainer = Color(0xFFFFD9DD),
    outline = Color(0xFF4A4378),
    outlineVariant = Color(0xFF2E2A55),
)

private val NightOwlShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun NightOwlTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = NightOwlColors,
        shapes = NightOwlShapes,
        typography = Typography(),
        content = content,
    )
}
