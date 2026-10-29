from ito_voice.check import Turn, contains, describe_finished, describe_unfinished, to_terms, word_errors


def test_word_errors_count_against_the_reference_words() -> None:
    assert word_errors("Ask Divy about the dinner.", "ask divvy about the dinner") == (1, 5)
    assert word_errors("Did Nnamdi call?", "Did N Namdi call?") == (2, 3)


def test_a_term_counts_only_as_whole_words() -> None:
    assert contains("Tell Saoirse the plan.", "saoirse")
    assert contains("the QRT panel meets", "QRT panel")
    assert not contains("Bramhecher dinner", "Bramhecha")
    assert not contains("anything", "")


def test_terms_use_their_own_phrases_or_a_sentence_for_their_kind() -> None:
    terms = to_terms(
        {
            "terms": [
                {"text": "Bora", "kind": "person", "phrases": ["Bora wants one more round."]},
                {"text": "Lisbon", "kind": "place", "phrases": ["See https://maps.example/Lisbon"]},
                {"text": "QRT", "kind": "term", "phrases": []},
                {"text": " ", "kind": "term", "phrases": []},
            ]
        }
    )

    assert [term.phrase for term in terms] == [
        "Bora wants one more round.",
        "We should go to Lisbon next month.",
        "Tell me more about QRT.",
    ]


def test_turns_that_end_early_or_wait_are_counted_apart() -> None:
    finished = [
        Turn("smart_turn", 0.98, 420.0, (30.0,)),
        Turn("smart_turn", 0.91, -900.0, (30.0,)),
        Turn("quiet", 0.2, 3100.0, (30.0,)),
        Turn(None, None, None, ()),
    ]
    unfinished = [Turn("quiet", 0.1, 3050.0, (30.0,)), Turn("smart_turn", 0.7, 300.0, (30.0,))]

    assert describe_finished(finished) == ("1/4 in 420 ms, **1 cut off mid-sentence**, 1 waited 4 s, **1 never ended**")
    assert describe_unfinished(unfinished) == "1/2 waited, **1 ended too soon**"
