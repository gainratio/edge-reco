Feature: Profile-aware reranking
  As a shopper
  I want recommendations that shift toward the things I'm interacting with
  So that the catalog feels personalized

  The taste profile lives on the device; the reranker only reads it.

  Background:
    Given the mini catalog of 50 products is loaded
    And a fresh empty session profile

  Scenario: Clicking an Electronics product shifts the top recommendation toward Electronics
    Given a candidate result list mixing Electronics and Books
    When the profile holds a click on product "B001"
    And I rerank the candidate list
    Then the top reranked product should be in the Electronics category

  Scenario: Repetition penalty pushes recently-viewed items down
    Given a candidate result list of three Electronics products
    When the profile holds a click on product "B001"
    And I rerank the candidate list
    Then product "B001" should not be the top reranked product

  Scenario: A fresh session has no affinity bias
    Given a candidate result list mixing Electronics and Books
    When I rerank the candidate list with the fresh empty session profile
    Then the reranked list should contain all candidates
