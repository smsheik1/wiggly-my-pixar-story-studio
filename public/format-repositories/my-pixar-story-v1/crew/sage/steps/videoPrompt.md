# videoPrompt

Criteria: keyframe-grounding, motion, physical-anchors, camera, continuity.

- keyframe-grounding: The prompt is conditioned on the approved keyframe and doesn't change what it shows.
- motion: One camera move, with action that matches the locked shot.
- physical-anchors: Actions are tied to physical anchors, such as hands on an object or feet on a surface.
- camera: The camera matches the locked shot's camera.
- continuity: Details match the keyframe and the neighboring clips.

The shell checks the 4,000-character cap. Check that the `repairOnly` flag is used only as the task allows.
