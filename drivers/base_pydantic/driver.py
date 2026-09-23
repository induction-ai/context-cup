"""base_pydantic: Pydantic AI with no context strategy, the baseline for
drivers built from Pydantic AI (Harness) capabilities. Copy this to write a
driver whose strategy is a list of capabilities; the engine does everything
else. See engines/pydantic/README.md for what the engine owns."""


def run(ctx):
    # Return the capabilities for this turn's agent. The engine builds the
    # Agent around them, connects it to the target through the run's proxy,
    # hands the course's tools over as external tools (the course runs them),
    # and loads the agent's own history from ctx.dirs.state.
    #
    # The baseline adds nothing. A strategy is a list, for example:
    #   from pydantic_ai_harness.compaction import ClearToolResults
    #   return [ClearToolResults(max_tokens=60_000, keep_pairs=3)]
    return []
