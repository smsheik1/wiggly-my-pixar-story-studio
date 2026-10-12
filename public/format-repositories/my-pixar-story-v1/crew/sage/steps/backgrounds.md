# backgrounds

Criteria: scene-coverage, locations, angles, common-sense.

- scene-coverage: Every location has at least one scene, the scenes cover all four beats, and they bind established roster characters.
- locations: The location list is the minimum the story needs and matches the approved shot plan's locations exactly.
- angles: Every location produces one master plate automatically. `angles` is only for additional plates. If every approved shot uses the master view (`angleId: null`), an empty `angles` array is correct and passes. Fail `angles` only when an approved shot binds a non-null `angleId` and the deliverable has no matching angle; quote the shot and name the missing angle in the repair.
- common-sense: Locations and scenes make physical sense for the story.
