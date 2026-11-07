package com.voiza.app.viewmodel

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The string the backend keys an account on. The country-code field filters itself to digits, so a
 * member who retypes "+92" leaves "92" in the box — and a phone sent without its prefix is not the
 * same account dialled differently, it is a second account with nothing in it. The "+" therefore
 * belongs to the composition, not to the text box.
 */
class AuthPhoneCompositionTest {

    @Test
    fun `the untouched country code composes as it always did`() {
        assertEquals("+15550001122", AuthViewModel.AuthUiState(phone = "5550001122").e164())
    }

    @Test
    fun `a retyped code keeps the plus the server matches on`() {
        // What the field holds after someone clears "+1" and dials Pakistan.
        val state = AuthViewModel.AuthUiState(countryCode = "92", phone = "3007774393")
        assertEquals("+923007774393", state.e164())

        // A plus typed into the field never survives its own filter, so composing must not add a second.
        assertEquals("+923007774393", state.copy(countryCode = "+92").e164())
    }

    @Test
    fun `separators dialled into the number do not reach the server`() {
        val state = AuthViewModel.AuthUiState(countryCode = "+92", phone = "300-777 4393")
        assertEquals("+923007774393", state.e164())
    }
}
